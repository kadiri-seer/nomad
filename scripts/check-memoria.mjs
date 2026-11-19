#!/usr/bin/env node
// Checks Nomad's Memoria support with Memoria's real server and the real Codex and OpenClaw, in a throwaway home:
// 1. Memoria's hosted server answers and refuses a request with no key (401, asking for a Bearer key), which is
//    why the preview says to set MEMORIA_API_KEY before starting the app. One request, no key, no account.
// 2. A Claude Code setup with a (fake) key in its header is moved to Codex and OpenClaw. Codex lists the server
//    with bearer_token_env_var = MEMORIA_API_KEY, OpenClaw accepts its config, and the key is nowhere in what Nomad wrote.
// Run after `pnpm build:cli`, with codex and openclaw on PATH or in NOMAD_APPS_BIN.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/nomad.js");
const bin = (name) => (process.env.NOMAD_APPS_BIN ? join(process.env.NOMAD_APPS_BIN, name) : name);
const URL_MEMORIA = "https://www.memoriaagent.site/mcp";
// A fake key in Memoria's shape ("mem_", 12 hex, "_", 43 base64url characters). It belongs to no account and is never sent.
const FAKE_KEY = "mem_" + "3f9a1c2b7d4e" + "_" + "Q7mVx2Lr9Tz4Kp8Ns1Wd6Hc3Jb5Fy0Ga7Pe2Ru4Si9O";
const home = mkdtempSync(join(tmpdir(), "nomad-memoria-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, NOMAD_FAKE_HOME: home, NOMAD_HOME: join(home, ".nomad"), CODEX_HOME: join(home, ".codex"), NO_COLOR: "1", CI: "1" };
delete env.MEMORIA_API_KEY;
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `\n     ${String(detail).trim().split("\n").join("\n     ")}` : ""}`);
  if (!ok) failed++;
};
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: home, env, encoding: "utf8", timeout: 180000 });
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
const allText = (dir) => {
  if (!existsSync(dir)) return "";
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out.join("\n");
};

try {
  const r = await fetch(URL_MEMORIA, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nomad-check", version: "1.0" } } }),
    signal: AbortSignal.timeout(30000)
  }).catch((e) => ({ status: String(e), headers: new Headers() }));
  check(`Memoria answers at ${URL_MEMORIA} and refuses a request with no key (401)`, r.status === 401, String(r.status));
  check("it asks for a Bearer key", /bearer/i.test(r.headers.get("www-authenticate") ?? ""), r.headers.get("www-authenticate") ?? "(no www-authenticate)");

  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# Rules\n\n- Save what you learn to Memoria with the reason.\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { memoria: { type: "http", url: URL_MEMORIA, headers: { Authorization: `Bearer ${FAKE_KEY}` } } } }));
  for (const to of ["codex", "openclaw"]) {
    const m = run(process.execPath, [cli, "migrate", "--from", "claude-code", "--to", to, "-y"]);
    check(`nomad moved the setup to ${to}`, m.code === 0, m.out + m.err);
    check(`the preview for ${to} says to set MEMORIA_API_KEY`, (m.out + m.err).includes("MEMORIA_API_KEY"), m.out + m.err);
  }
  const c = run(bin("codex"), ["mcp", "list", "--json"]);
  const cby = Object.fromEntries((json(c.out) ?? []).map((s) => [s.name, s]));
  check("codex lists Memoria's server", cby.memoria?.transport?.url === URL_MEMORIA, JSON.stringify(cby.memoria) + c.err);
  check("codex reads the key from MEMORIA_API_KEY (bearer_token_env_var)", JSON.stringify(cby.memoria ?? {}).includes("MEMORIA_API_KEY"), JSON.stringify(cby.memoria));
  const v = run(bin("openclaw"), ["config", "validate"]);
  check("openclaw accepts its config", v.code === 0, v.out + v.err);
  const o = run(bin("openclaw"), ["mcp", "list", "--json"]);
  check("openclaw lists Memoria's server", (json(o.out) ?? {}).memoria?.url === URL_MEMORIA, o.out + o.err);
  for (const dir of [".codex", ".openclaw", ".nomad"]) check(`the key is nowhere in ${dir}`, !allText(join(home, dir)).includes(FAKE_KEY));
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nMemoria checks passed.");
process.exit(failed ? 1 : 0);
