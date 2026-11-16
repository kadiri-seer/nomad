#!/usr/bin/env node
// Checks Nomad's Rushr support with the real apps and Rushr's real package, in throwaway homes:
// 1. Rushr's Codex plugin, installed by the real Codex, is read by Nomad and moved to Gemini CLI
//    (as an ordinary server) and to another Codex (as install steps, which then work as printed).
// 2. Rushr's MCP server starts in dry run with no wallet and lists its tools. Nothing is signed or sent.
// Run after `pnpm build:cli`, with codex and gemini on PATH or in NOMAD_APPS_BIN. --skip-server skips part 2.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/nomad.js");
const bin = (name) => (process.env.NOMAD_APPS_BIN ? join(process.env.NOMAD_APPS_BIN, name) : name);
const VERSION = process.env.RUSHR_MCP_VERSION ?? "0.1.2";
const home = mkdtempSync(join(tmpdir(), "nomad-rushr-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, NOMAD_FAKE_HOME: home, NOMAD_HOME: join(home, ".nomad"), CODEX_HOME: join(home, ".codex"), NO_COLOR: "1", CI: "1" };
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `\n     ${String(detail).trim().split("\n").join("\n     ")}` : ""}`);
  if (!ok) failed++;
};
const run = (cmd, args, extra = {}) => {
  const r = spawnSync(cmd, args, { cwd: home, env: { ...env, ...extra }, encoding: "utf8", timeout: 180000 });
  return { code: r.status, out: r.stdout ?? "", err: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
};
const json = (text) => {
  const i = text.search(/[[{]/);
  try {
    return i < 0 ? undefined : JSON.parse(text.slice(i));
  } catch {
    return undefined;
  }
};

try {
  // 1. The Codex plugin, installed by the real Codex.
  mkdirSync(join(home, ".codex"), { recursive: true });
  let r = run(bin("codex"), ["plugin", "marketplace", "add", "rushr-dev/platform"]);
  check("codex installs Rushr's marketplace", r.code === 0, r.out + r.err);
  r = run(bin("codex"), ["plugin", "add", "rushr@rushr"]);
  check("codex installs the rushr plugin", r.code === 0, r.out + r.err);

  r = run(process.execPath, [cli, "migrate", "--from", `codex:${join(home, ".codex")}`, "--to", "gemini-cli", "--dest-dir", join(home, ".gemini"), "-y"]);
  check("nomad moves the Codex plugin to Gemini CLI", r.code === 0, r.out + r.err);
  check("the preview says it trades real ETH", /"rushr" trades real ETH on Robinhood Chain mainnet \(4663\)/.test(r.out + r.err), r.out + r.err);
  const g = run(bin("gemini"), ["mcp", "list"]);
  check("gemini lists the plugin's server as its own", (g.out + g.err).includes("rushr: npx -y @rushr/mcp@latest (stdio)"), g.out + g.err);

  const other = join(home, "other");
  mkdirSync(join(other, ".codex"), { recursive: true });
  r = run(process.execPath, [cli, "migrate", "--from", `codex:${join(home, ".codex")}`, "--to", "codex", "--dest-dir", join(other, ".codex"), "-y"]);
  const step = "codex plugin marketplace add rushr-dev/platform, then codex plugin add rushr@rushr";
  check("nomad gives another Codex the plugin's install steps", r.code === 0 && (r.out + r.err).includes(step), r.out + r.err);
  const otherEnv = { HOME: other, USERPROFILE: other, CODEX_HOME: join(other, ".codex") };
  const before = json(run(bin("codex"), ["mcp", "list", "--json"], otherEnv).out) ?? [];
  check("nomad did not copy the plugin's server into that Codex", !before.some((s) => s.name === "rushr"), JSON.stringify(before));
  run(bin("codex"), ["plugin", "marketplace", "add", "rushr-dev/platform"], otherEnv);
  run(bin("codex"), ["plugin", "add", "rushr@rushr"], otherEnv);
  const after = json(run(bin("codex"), ["mcp", "list", "--json"], otherEnv).out) ?? [];
  check("following the printed steps brings the plugin back", after.some((s) => s.name === "rushr" && JSON.stringify(s.transport?.args) === JSON.stringify(["-y", "@rushr/mcp@latest"])), JSON.stringify(after));

  // 2. Rushr's server, dry run, no wallet.
  if (!process.argv.includes("--skip-server")) {
    const tools = await new Promise((done) => {
      const p = spawn("npx", ["-y", `@rushr/mcp@${VERSION}`], { cwd: home, env: { ...env, RUSHR_DRY_RUN: "1", RUSHR_STATE_DIR: join(home, "rushr-state") }, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
      let buf = "";
      let err = "";
      const finish = (v) => {
        clearTimeout(timer);
        p.kill();
        done(v);
      };
      const timer = setTimeout(() => finish({ names: [], err: `timed out. ${err}` }), 120000);
      p.stderr.on("data", (d) => (err += d));
      p.stdout.on("data", (d) => {
        buf += d;
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.id === 1) {
            p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
          }
          if (m.id === 2) finish({ names: (m.result?.tools ?? []).map((t) => t.name), err });
        }
      });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nomad-check", version: "1.0" } } }) + "\n");
    });
    check(`@rushr/mcp@${VERSION} starts in dry run with no wallet and lists its tools (${tools.names.length})`, tools.names.includes("buy") && tools.names.includes("sell") && tools.names.includes("scan"), tools.err || tools.names.join(", "));
    let made = "";
    try {
      made = readFileSync(join(home, ".rushr/agent-wallet.json"), "utf8");
    } catch {
      /* none, as expected */
    }
    check("no wallet was created", made === "");
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nRushr checks passed.");
process.exit(failed ? 1 : 0);
