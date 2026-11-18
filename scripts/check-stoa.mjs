#!/usr/bin/env node
// Checks Nomad's Stoa support with Stoa's real server and the real Codex and OpenClaw, in a throwaway home:
// 1. Stoa's hosted server answers with no key and lists the tools its docs name; list_tokens names the router
//    Nomad's preview tells people to check. Read-only: nothing is built, signed or sent.
// 2. A Claude Code setup with Stoa's server and skill is moved to Codex and OpenClaw, which list the server.
// Run after `pnpm build:cli`, with codex and openclaw on PATH or in NOMAD_APPS_BIN.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/nomad.js");
const bin = (name) => (process.env.NOMAD_APPS_BIN ? join(process.env.NOMAD_APPS_BIN, name) : name);
const URL_STOA = "https://stoadex.com/mcp";
const ROUTER = "0x2F2804fad735a38015650f32f95Ad5E08D6B3eE5";
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nomad-check", version: "1.0" } } };
const home = mkdtempSync(join(tmpdir(), "nomad-stoa-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, NOMAD_FAKE_HOME: home, NOMAD_HOME: join(home, ".nomad"), CODEX_HOME: join(home, ".codex"), NO_COLOR: "1", CI: "1" };
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
const post = async (id, method, params) => {
  const r = await fetch(URL_STOA, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(30000) });
  return { status: r.status, body: json(await r.text()) };
};

try {
  const init = await post(1, "initialize", INIT.params).catch((e) => ({ status: String(e) }));
  check(`Stoa answers at ${URL_STOA} without a key (${init.body?.result?.serverInfo?.name ?? "no name"})`, init.status === 200 && !!init.body?.result, JSON.stringify(init));
  const list = await post(2, "tools/list", {}).catch(() => ({}));
  const names = (list.body?.result?.tools ?? []).map((t) => t.name);
  for (const n of ["list_tokens", "quote", "build_swap", "safety_check", "stock_tokens"]) check(`it offers ${n}`, names.includes(n), names.join(", "));
  const tokens = await post(3, "tools/call", { name: "list_tokens", arguments: { chain: "robinhood" } }).catch(() => ({}));
  const router = tokens.body?.result?.structuredContent?.router ?? json(tokens.body?.result?.content?.[0]?.text ?? "")?.router;
  check(`list_tokens names the router the preview tells people to check (${ROUTER})`, String(router).toLowerCase() === ROUTER.toLowerCase(), String(router));

  mkdirSync(join(home, ".claude/skills/stoa"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# Rules\n\n- Run Stoa's safety check first.\n");
  writeFileSync(join(home, ".claude/skills/stoa/SKILL.md"), "---\nname: stoa\ndescription: Quote and build swaps with Stoa.\n---\n\nConfirm tx.to is the Stoa router.\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { stoa: { type: "http", url: URL_STOA } } }));
  for (const to of ["codex", "openclaw"]) {
    const m = run(process.execPath, [cli, "migrate", "--from", "claude-code", "--to", to, "-y"]);
    check(`nomad moved the setup to ${to}`, m.code === 0, m.out + m.err);
  }
  const c = run(bin("codex"), ["mcp", "list", "--json"]);
  const cby = Object.fromEntries((json(c.out) ?? []).map((s) => [s.name, s]));
  check("codex lists Stoa's server", cby.stoa?.transport?.url === URL_STOA, JSON.stringify(cby.stoa));
  const v = run(bin("openclaw"), ["config", "validate"]);
  check("openclaw accepts its config", v.code === 0, v.out + v.err);
  const o = run(bin("openclaw"), ["mcp", "list", "--json"]);
  check("openclaw lists Stoa's server", (json(o.out) ?? {}).stoa?.url === URL_STOA, o.out + o.err);
  let skill = "";
  try {
    skill = readFileSync(join(home, ".openclaw/workspace/skills/stoa/SKILL.md"), "utf8");
  } catch {
    /* checked below */
  }
  check("the stoa skill arrives in OpenClaw", skill.includes("Confirm tx.to is the Stoa router"));
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nStoa checks passed.");
process.exit(failed ? 1 : 0);
