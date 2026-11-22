#!/usr/bin/env node
// Checks Nomad's OddsEngine support with OddsEngine's real server and the real Codex and OpenClaw, in a throwaway home:
// 1. OddsEngine's hosted server answers, and refuses a tool call with no key, which is why the preview says to set
//    ODDSENGINE_API_KEY before starting the app. Three requests, no key, no account.
// 2. A Cursor setup with a (fake) key in its address is moved to Codex and OpenClaw. Codex lists the plain address
//    with bearer_token_env_var = ODDSENGINE_API_KEY, OpenClaw accepts its config, and the key is nowhere in what Nomad wrote.
// Run after `pnpm build:cli`, with codex and openclaw on PATH or in NOMAD_APPS_BIN.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/nomad.js");
const bin = (name) => (process.env.NOMAD_APPS_BIN ? join(process.env.NOMAD_APPS_BIN, name) : name);
const URL_ODDS = "https://api.oddsengine.live/mcp";
// A fake key in OddsEngine's shape ("oe_live_" and 40 characters). It belongs to no account and is never sent.
const FAKE_KEY = "oe_live_" + "Hq7Lm2Vx9Tz4Kp8Ns1Wd6Rc3Jb5Fy0GaP2eUu4S";
const home = mkdtempSync(join(tmpdir(), "nomad-oddsengine-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, NOMAD_FAKE_HOME: home, NOMAD_HOME: join(home, ".nomad"), CODEX_HOME: join(home, ".codex"), NO_COLOR: "1", CI: "1" };
delete env.ODDSENGINE_API_KEY;
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
  // OddsEngine opens a session without a key; its tools need one. Open a session, then call balance with no key.
  let session = null;
  const post = async (payload) => {
    const r = await fetch(URL_ODDS, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...payload }),
      signal: AbortSignal.timeout(30000)
    }).catch((e) => ({ status: String(e), headers: new Headers(), text: async () => "" }));
    session = r.headers.get("mcp-session-id") ?? session;
    return { status: r.status, body: await r.text().catch(() => "") };
  };
  const init = await post({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nomad-check", version: "1.0" } } });
  check(`OddsEngine answers at ${URL_ODDS}`, init.status === 200 && init.body.includes("oddsengine"), `${init.status} ${init.body.slice(0, 200)}`);
  await post({ method: "notifications/initialized" });
  const call = await post({ id: 2, method: "tools/call", params: { name: "balance", arguments: {} } });
  const refused = call.status === 401 || call.status === 403 || /"error"\s*:/.test(call.body) || /"isError"\s*:\s*true/.test(call.body);
  check("a tool call with no key is refused", refused, `${call.status} ${call.body.slice(0, 300)}`);

  mkdirSync(join(home, "project/.cursor"), { recursive: true });
  writeFileSync(join(home, "project/.cursorrules"), "Scan every token with OddsEngine before buying.\n");
  writeFileSync(join(home, "project/.cursor/mcp.json"), JSON.stringify({ mcpServers: { oddsengine: { url: `${URL_ODDS}/k/${FAKE_KEY}` } } }));
  for (const to of ["codex", "openclaw"]) {
    const m = run(process.execPath, [cli, "migrate", "--from", `cursor:${join(home, "project")}`, "--to", to, "-y"]);
    check(`nomad moved the setup to ${to}`, m.code === 0, m.out + m.err);
    check(`the preview for ${to} says to set ODDSENGINE_API_KEY`, (m.out + m.err).includes("ODDSENGINE_API_KEY"), m.out + m.err);
  }
  const c = run(bin("codex"), ["mcp", "list", "--json"]);
  const cby = Object.fromEntries((json(c.out) ?? []).map((s) => [s.name, s]));
  check("codex lists OddsEngine's plain address", cby.oddsengine?.transport?.url === URL_ODDS, JSON.stringify(cby.oddsengine) + c.err);
  check("codex reads the key from ODDSENGINE_API_KEY (bearer_token_env_var)", JSON.stringify(cby.oddsengine ?? {}).includes("ODDSENGINE_API_KEY"), JSON.stringify(cby.oddsengine));
  const v = run(bin("openclaw"), ["config", "validate"]);
  check("openclaw accepts its config", v.code === 0, v.out + v.err);
  const o = run(bin("openclaw"), ["mcp", "list", "--json"]);
  check("openclaw lists OddsEngine's plain address", (json(o.out) ?? {}).oddsengine?.url === URL_ODDS, o.out + o.err);
  for (const dir of [".codex", ".openclaw", ".nomad"]) check(`the key is nowhere in ${dir}`, !allText(join(home, dir)).includes(FAKE_KEY));
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nOddsEngine checks passed.");
process.exit(failed ? 1 : 0);
