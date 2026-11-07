import { spawn } from "node:child_process";
import { basename } from "node:path";
import { NomadError } from "@nomad/core";

/**
 * Experimental remote migration over SSH. Nomad never disables host key
 * checking: an unknown host fails with instructions to verify its fingerprint.
 */

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\/.:=@%+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => reject(new NomadError(`${cmd} is not available: ${e.message}`, "ssh-missing", "Install OpenSSH to use remote migration.")));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

export interface RemoteOptions {
  host: string;
  port?: number;
  identity?: string;
  /** Command that runs Nomad on the remote host, for example "npx -y @nomad/cli@0.1.0" or "nomad". */
  remoteCommand: string;
}

function sshBase(o: RemoteOptions): string[] {
  const args = ["-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes"];
  if (o.port) args.push("-p", String(o.port));
  if (o.identity) args.push("-i", o.identity);
  return args;
}

function explain(stderr: string, host: string): never {
  if (/Host key verification failed|No .* host key is known/i.test(stderr)) {
    throw new NomadError(`The host key of ${host} is not trusted yet.`, "host-key", `Connect once with "ssh ${host}", compare the fingerprint with the server's real one, then try again. Nomad does not skip host key checks.`);
  }
  if (/Permission denied/i.test(stderr)) throw new NomadError(`SSH authentication to ${host} failed.`, "ssh-auth", "Check the key with --identity or your ssh-agent.");
  throw new NomadError(`SSH command failed: ${stderr.trim().split("\n").pop()}`, "ssh-failed");
}

/** Copy a package to the host and run a Nomad migration there (preview unless apply is true). */
export async function remoteMigrate(o: RemoteOptions, packagePath: string, args: { to: string; dest: string; mode: string; apply: boolean }) {
  const mk = await run("ssh", [...sshBase(o), o.host, "mktemp -d"]);
  if (mk.code !== 0) explain(mk.stderr, o.host);
  const dir = mk.stdout.trim();
  if (!/^\/[\w./-]+$/.test(dir)) throw new NomadError("Unexpected temporary directory from the remote host.", "ssh-failed");
  const scpArgs = ["-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", ...(o.port ? ["-P", String(o.port)] : []), ...(o.identity ? ["-i", o.identity] : []), packagePath, `${o.host}:${dir}/${basename(packagePath)}`];
  const cp = await run("scp", scpArgs);
  if (cp.code !== 0) explain(cp.stderr, o.host);
  const remotePack = `${dir}/${basename(packagePath)}`;
  const cmd = [o.remoteCommand, "migrate", "--from", shellQuote(remotePack), "--to", shellQuote(args.to), "--dest-dir", shellQuote(args.dest), "--mode", shellQuote(args.mode), ...(args.apply ? ["--yes"] : ["--dry-run"]), "--json"].join(" ");
  const r = await run("ssh", [...sshBase(o), o.host, `${cmd}; status=$?; rm -rf ${shellQuote(dir)}; exit $status`]);
  if (r.code !== 0 && !r.stdout.trim()) explain(r.stderr, o.host);
  try {
    return { code: r.code, result: JSON.parse(r.stdout) };
  } catch {
    return { code: r.code, result: r.stdout };
  }
}
