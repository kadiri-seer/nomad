#!/usr/bin/env node
// Checks Nomad's Zolva support with Zolva's real server and the real Codex and OpenClaw, in a throwaway home:
// 1. Zolva's hosted server answers with no key and lists the seven read-only tools its docs name, and it
//    refuses a wrong key with 401, which is why the preview says to set ZOLVA_KEY before starting the app.
//    Read-only: no tool is called and no account is used.
// 2. A Claude Code setup with a (fake) key in its header is moved to Codex and OpenClaw. Codex lists the server
//    with bearer_token_env_var = ZOLVA_KEY, OpenClaw accepts its config, and the key is nowhere in what Nomad wrote.
// Run after `pnpm build:cli`, with codex and openclaw on PATH or in NOMAD_APPS_BIN.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/nomad.js");
const bin = (name) => (process.env.NOMAD_APPS_BIN ? join(process.env.NOMAD_APPS_BIN, name) : name);
const URL_ZOLVA = "https://zolvaagent.app/mcp";
// A fake key in Zolva's shape ("zk_" and 43 base64url characters). It belongs to no account.
const FAKE_KEY = "zk_" + "Q7mVx2Lr9Tz4Kp8Ns1Wd6Hc3Jb5Fy0Ga7Pe2Ru4Si9O";
const TOOLS = ["list_agents", "verify_agent", "get_agent", "list_markets", "get_market", "recent_activity", "get_consensus"];
const home = mkdtempSync(join(tmpdir(), "nomad-zolva-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, NOMAD_FAKE_HOME: home, NOMAD_HOME: join(home, ".nomad"), CODEX_HOME: join(home, ".codex"), NO_COLOR: "1", CI: "1" };
delete env.ZOLVA_KEY;
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
const post = async (id, method, params, headers = {}) => {
  const r = await fetch(URL_ZOLVA, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(30000) });
  return { status: r.status, body: json(await r.text()) };
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
  const init = await post(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nomad-check", version: "1.0" } }).catch((e) => ({ status: String(e) }));
  check(`Zolva answers at ${URL_ZOLVA} without a key (${init.body?.result?.serverInfo?.name ?? "no name"})`, init.status === 200 && !!init.body?.result, JSON.stringify(init));
  const list = await post(2, "tools/list", {}).catch(() => ({}));
  const names = (list.body?.result?.tools ?? []).map((t) => t.name);
  for (const n of TOOLS) check(`it offers ${n} without a key`, names.includes(n), names.join(", "));
  check("without a key it offers no account tools", !names.some((n) => ["my_agents", "create_paper_agent", "pause_live_agent"].includes(n)), names.join(", "));
  const wrong = await post(3, "tools/list", {}, { authorization: `Bearer ${FAKE_KEY}` }).catch((e) => ({ status: String(e) }));
  check("a wrong key is refused (401), so an unset or wrong ZOLVA_KEY stops the keyless tools too", wrong.status === 401, JSON.stringify(wrong));

  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# Rules\n\n- Backtest a Zolva strategy before suggesting it.\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { zolva: { type: "http", url: URL_ZOLVA, headers: { Authorization: `Bearer ${FAKE_KEY}` } } } }));
  for (const to of ["codex", "openclaw"]) {
    const m = run(process.execPath, [cli, "migrate", "--from", "claude-code", "--to", to, "-y"]);
    check(`nomad moved the setup to ${to}`, m.code === 0, m.out + m.err);
    check(`the preview for ${to} says to set ZOLVA_KEY`, (m.out + m.err).includes("ZOLVA_KEY"), m.out + m.err);
  }
  const c = run(bin("codex"), ["mcp", "list", "--json"]);
  const cby = Object.fromEntries((json(c.out) ?? []).map((s) => [s.name, s]));
  check("codex lists Zolva's server", cby.zolva?.transport?.url === URL_ZOLVA, JSON.stringify(cby.zolva) + c.err);
  check("codex reads the key from ZOLVA_KEY (bearer_token_env_var)", JSON.stringify(cby.zolva ?? {}).includes("ZOLVA_KEY"), JSON.stringify(cby.zolva));
  const v = run(bin("openclaw"), ["config", "validate"]);
  check("openclaw accepts its config", v.code === 0, v.out + v.err);
  const o = run(bin("openclaw"), ["mcp", "list", "--json"]);
  check("openclaw lists Zolva's server", (json(o.out) ?? {}).zolva?.url === URL_ZOLVA, o.out + o.err);
  for (const dir of [".codex", ".openclaw", ".nomad"]) check(`the key is nowhere in ${dir}`, !allText(join(home, dir)).includes(FAKE_KEY));
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nZolva checks passed.");
process.exit(failed ? 1 : 0);
