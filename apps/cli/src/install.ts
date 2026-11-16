import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { NOMAD_VERSION } from "@nomad/core";

/**
 * Nomad installed with the one-line installer (thenomad.website/install.ps1 or install.sh)
 * lives in one folder:
 *
 *   <root>/app/<version>/   the runtime and Nomad for that version
 *   <root>/bin/             the nomad command, the app launcher, the uninstaller, the icon
 *   <root>/current          the version the launchers run
 *   <root>/install.json     written by the installer
 *
 * Updating puts the new version next to the old one, checks it, then switches `current`,
 * so a failed update leaves the working version in place.
 */

export const REPO = "kadiri-seer/nomad";
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface Install {
  root: string;
  target: string;
  version: string;
}

/** The installer-managed install this process runs from, or null for npm, npx or a checkout. */
export function currentInstall(execPath = process.execPath): Install | null {
  const appDir = dirname(execPath);
  if (basename(dirname(appDir)) !== "app" || !VERSION_RE.test(basename(appDir))) return null;
  const root = dirname(dirname(appDir));
  try {
    const info = JSON.parse(readFileSync(join(root, "install.json"), "utf8")) as { by?: string; target?: string };
    if (info.by !== "nomad-installer" || typeof info.target !== "string" || !/^(windows|macos|linux)-(x64|arm64)$/.test(info.target)) return null;
    return { root, target: info.target, version: basename(appDir) };
  } catch {
    return null;
  }
}

/** a > b for x.y.z versions. */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

export function assetName(target: string): string {
  return `nomad-${target}.${target.startsWith("windows") ? "zip" : "tar.gz"}`;
}

/** Parse a SHA256SUMS file: "<64 hex>  <name>" per line. */
export function checksumFor(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

async function get(url: string): Promise<Response> {
  const host = new URL(url).host;
  let r: Response;
  try {
    r = await fetch(url, { headers: { "User-Agent": `nomad/${NOMAD_VERSION}`, Accept: host === "api.github.com" ? "application/vnd.github+json" : "*/*" }, redirect: "follow", ...(host === "api.github.com" ? { signal: AbortSignal.timeout(30000) } : {}) });
  } catch {
    throw new Error(`Could not reach ${host}. Check your connection and try again.`);
  }
  if (r.status === 404 && host === "api.github.com") throw new Error("No Nomad release was found on GitHub. Try again later.");
  if (!r.ok) throw new Error(`Could not reach ${host} (HTTP ${r.status}). Try again later.`);
  return r;
}

/** The newest released version, from GitHub. */
export async function latestVersion(): Promise<string> {
  const data = (await (await get(`https://api.github.com/repos/${REPO}/releases/latest`)).json()) as { tag_name?: unknown };
  const tag = typeof data.tag_name === "string" ? data.tag_name : "";
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("GitHub returned an unexpected release name. Try again later.");
  return tag.slice(1);
}

export interface UpdateCheck {
  installed: boolean;
  current: string;
  latest?: string;
  available?: boolean;
}

export async function checkForUpdate(install = currentInstall()): Promise<UpdateCheck> {
  if (!install) return { installed: false, current: NOMAD_VERSION };
  const latest = await latestVersion();
  return { installed: true, current: install.version, latest, available: newer(latest, install.version) };
}

function systemTar(): string {
  if (process.platform === "win32") return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  for (const p of ["/usr/bin/tar", "/bin/tar"]) if (existsSync(p)) return p;
  return "tar";
}

/** Antivirus scanners can hold a just-unpacked file open for a moment on Windows: retry the rename. */
function renameWithRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function removeQuietly(p: string) {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* left for the next update */
  }
}

/** Windows cannot delete a folder while a program in it runs: remove it a few seconds after this process exits. */
function removeAfterExit(dir: string) {
  if (process.platform !== "win32") return removeQuietly(dir);
  const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; Remove-Item -LiteralPath $env:NOMAD_OLD_DIR -Recurse -Force -ErrorAction SilentlyContinue`;
  spawn(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, NOMAD_OLD_DIR: dir } }).unref();
}

/**
 * Download, check and switch to `version`. Never touches the running version until the new one
 * has passed its checks; returns the version now current.
 */
export async function applyUpdate(install: Install, version: string, log: (line: string) => void = () => undefined): Promise<string> {
  if (!VERSION_RE.test(version)) throw new Error(`Not a version: ${version}`);
  const asset = assetName(install.target);
  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  const work = join(install.root, `tmp-${randomBytes(6).toString("hex")}`);
  mkdirSync(work, { recursive: true });
  try {
    log(`Downloading Nomad ${version}...`);
    const sums = await (await get(`${base}/SHA256SUMS`)).text();
    const expected = checksumFor(sums, asset);
    if (!expected) throw new Error(`The release has no fingerprint for ${asset}. Nothing was changed.`);
    const bytes = Buffer.from(await (await get(`${base}/${asset}`)).arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error("The download does not match its published fingerprint. Nothing was changed.");
    log("Fingerprint checked.");
    const archive = join(work, asset);
    writeFileSync(archive, bytes);

    const staged = join(work, "app");
    mkdirSync(staged);
    const x = spawnSync(systemTar(), [install.target.startsWith("windows") ? "-xf" : "-xzf", archive, "-C", staged], { stdio: "pipe" });
    if (x.status !== 0) throw new Error(`Could not unpack the download: ${String(x.stderr ?? x.error ?? "").trim()}`);
    const node = join(staged, process.platform === "win32" ? "node.exe" : "node");
    const check = spawnSync(node, [join(staged, "node_modules", "thenomad", "dist", "nomad.js"), "--version"], { encoding: "utf8", timeout: 60000 });
    if (check.status !== 0 || check.stdout.trim() !== version) throw new Error(`The new version did not start correctly. Nothing was changed.${check.stderr ? `\n${check.stderr.trim()}` : ""}`);

    const target = join(install.root, "app", version);
    if (resolve(target) === resolve(dirname(process.execPath))) throw new Error(`Nomad ${version} is the version running now.`);
    removeQuietly(target);
    renameWithRetry(staged, target);

    // Launchers, uninstaller and icon come with each version.
    const launcher = join(target, "launcher");
    if (existsSync(launcher)) {
      for (const f of readdirSync(launcher)) {
        cpSync(join(launcher, f), join(install.root, "bin", f), { force: true });
        if (process.platform !== "win32" && !f.endsWith(".png") && !f.endsWith(".icns")) chmodSync(join(install.root, "bin", f), 0o755);
      }
    }

    // Switch: write the new version name, then rename over the old file.
    const next = join(install.root, `current.${randomBytes(4).toString("hex")}`);
    writeFileSync(next, version);
    renameSync(next, join(install.root, "current"));
    const infoPath = join(install.root, "install.json");
    const info = JSON.parse(readFileSync(infoPath, "utf8"));
    writeFileSync(infoPath, JSON.stringify({ ...info, version, updated: new Date().toISOString() }, null, 2) + "\n");
    if (process.platform === "win32") {
      const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
      spawnSync(reg, ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nomad", "/v", "DisplayVersion", "/t", "REG_SZ", "/d", version, "/f"], { stdio: "ignore" });
    }

    // Older versions go; the running one goes after this process exits.
    const running = resolve(dirname(process.execPath));
    for (const v of readdirSync(join(install.root, "app"))) {
      const dir = resolve(install.root, "app", v);
      if (v === version) continue;
      if (dir === running) removeAfterExit(dir);
      else removeQuietly(dir);
    }
    return version;
  } finally {
    removeQuietly(work);
  }
}

/** Run the uninstaller that came with this install. Returns false if it could not start. */
export function runUninstaller(install: Install, opts: { removeData: boolean; dataDir: string }): boolean {
  if (process.platform === "win32") {
    const script = join(install.root, "bin", "uninstall.ps1");
    if (!existsSync(script)) return false;
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // It waits for this process to exit, because Windows cannot delete a running program.
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Yes", "-WaitPid", String(process.pid), "-DataDir", opts.dataDir];
    if (opts.removeData) args.push("-RemoveData");
    spawn(ps, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  }
  const script = join(install.root, "bin", "uninstall.sh");
  if (!existsSync(script)) return false;
  const args = [script, "--yes", "--data-dir", opts.dataDir];
  if (opts.removeData) args.push("--remove-data");
  const r = spawnSync("/bin/sh", args, { stdio: "inherit" });
  return r.status === 0;
}
