#!/usr/bin/env node
// Checks Nomad's Ostra support with Ostra's real package and connector and the real Codex and OpenClaw,
// in a throwaway home:
// 1. @ostraagent/mcp starts in a throwaway OSTRA_HOME with Ostra's services turned off and lists its tools.
//    Nothing is funded, signed or sent; the folder is deleted afterwards.
// 2. Ostra's hosted connector answers at its address (it asks to sign in).
// 3. A Claude Code setup with Ostra (a keyed RPC, a service turned off, the connector) and a planted seed
//    folder and backup is moved to Codex and OpenClaw, which list the servers; the seed, the backup and the
//    RPC key are nowhere in what Nomad wrote.
// Run after `pnpm build:cli`, with codex and openclaw on PATH or in NOMAD_APPS_BIN.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/nomad.js");
const bin = (name) => (process.env.NOMAD_APPS_BIN ? join(process.env.NOMAD_APPS_BIN, name) : name);
const VERSION = process.env.OSTRA_MCP_VERSION ?? "0.1.24";
const CONNECTOR = "https://mcp.ostraagent.xyz/mcp";
// Fake values: a provider key in an RPC URL, a seed and a backup's ciphertext.
const RPC_WITH_KEY = "https://robinhood-mainnet.g.alchemy.com/v2/" + "k9Qm2Vx7Lr4Tz8Kp1Ns6Wd3Hc5Jb0Fy";
const SEED = "5f".repeat(32);
const CIPHERTEXT = "a1b2c3d4e5f60718".repeat(4);
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nomad-check", version: "1.0" } } };
const OFF = { OSTRA_RELAYER_URL: "off", OSTRA_KEEPER_URL: "off", OSTRA_AGGREGATOR_URL: "off", OSTRA_AI_URL: "off", OSTRA_RAETO_URL: "off", OSTRA_PAD_INDEXER_URL: "off", OSTRA_ETH_RPC_URL: "off" };
const home = mkdtempSync(join(tmpdir(), "nomad-ostra-"));
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
const readIf = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const allText = (dir) => {
  let out = "";
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    out += statSync(p).isDirectory() ? allText(p) : readIf(p);
  }
  return out;
};

function local(ostraHome) {
  return new Promise((done) => {
    const p = spawn("npx", ["-y", `@ostraagent/mcp@${VERSION}`], { cwd: home, env: { ...env, ...OFF, OSTRA_HOME: ostraHome }, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
    let buf = "";
    let err = "";
    const finish = (r) => {
      clearTimeout(timer);
      p.kill();
      done(r);
    };
    const timer = setTimeout(() => finish({ tools: [], err: `timed out. ${err.slice(-2000)}` }), 180000);
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
        if (m.id === 2) finish({ tools: (m.result?.tools ?? []).map((t) => t.name), err });
      }
    });
    p.stdin.write(JSON.stringify(INIT) + "\n");
  });
}

try {
  // 1. The package, in its own throwaway vault folder.
  const ostraHome = join(home, "vault-for-check");
  const l = await local(ostraHome);
  check(`@ostraagent/mcp@${VERSION} lists its tools (${l.tools.length}) with Ostra's services off`, l.tools.length > 0, l.err.slice(-1500));
  for (const n of ["open_vault", "balance"]) check(`@ostraagent/mcp@${VERSION} offers ${n}`, l.tools.includes(n), l.tools.join(", "));
  rmSync(ostraHome, { recursive: true, force: true });

  // 2. The hosted connector: unauthenticated, it should ask to sign in.
  let status = 0;
  try {
    const r = await fetch(CONNECTOR, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(INIT), signal: AbortSignal.timeout(30000) });
    status = r.status;
  } catch (e) {
    status = String(e);
  }
  check(`Ostra's connector answers at ${CONNECTOR} (HTTP ${status})`, status === 401 || status === 200, String(status));

  // 3. A setup with Ostra moved to the real Codex and OpenClaw.
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# Rules\n\n- Check the Ostra vault before paying.\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { ostra: { type: "stdio", command: "npx", args: ["-y", `@ostraagent/mcp@${VERSION}`], env: { OSTRA_RPC_URL: RPC_WITH_KEY, OSTRA_ETH_RPC_URL: "off" } }, "ostra-connector": { type: "http", url: CONNECTOR } } }));
  mkdirSync(join(home, ".ostra"), { recursive: true });
  writeFileSync(join(home, ".ostra/master.key"), SEED);
  writeFileSync(join(home, "ostra-seed-backup.json"), JSON.stringify({ version: 1, kdf: { name: "scrypt", N: 131072, r: 8, p: 1 }, salt: "0f".repeat(16), iv: "1e".repeat(12), ciphertext: CIPHERTEXT, tag: "2d".repeat(16) }));
  for (const to of ["codex", "openclaw"]) {
    const m = run(process.execPath, [cli, "migrate", "--from", "claude-code", "--to", to, "-y"]);
    check(`nomad moved the setup to ${to}`, m.code === 0, m.out + m.err);
  }
  {
    const r = run(bin("codex"), ["mcp", "list", "--json"]);
    const by = Object.fromEntries((json(r.out) ?? []).map((s) => [s.name, s]));
    check("codex: Ostra's server keeps its pin, off stays off, the keyed RPC is forwarded", JSON.stringify(by.ostra?.transport?.args) === JSON.stringify(["-y", `@ostraagent/mcp@${VERSION}`]) && by.ostra?.transport?.env?.OSTRA_ETH_RPC_URL === "off" && (by.ostra?.transport?.env_vars ?? []).includes("OSTRA_RPC_URL"), JSON.stringify(by.ostra));
    check("codex: Ostra's connector", by["ostra-connector"]?.transport?.url === CONNECTOR, JSON.stringify(by["ostra-connector"]));
  }
  {
    const v = run(bin("openclaw"), ["config", "validate"]);
    check("openclaw accepts its config", v.code === 0, v.out + v.err);
    const r = run(bin("openclaw"), ["mcp", "list", "--json"]);
    const by = json(r.out) ?? {};
    const file = json(readIf(join(home, ".openclaw/openclaw.json"))) ?? {};
    check("openclaw lists Ostra's server and connector", JSON.stringify(by.ostra?.args) === JSON.stringify(["-y", `@ostraagent/mcp@${VERSION}`]) && by["ostra-connector"]?.url === CONNECTOR && file?.mcp?.servers?.ostra?.env?.OSTRA_ETH_RPC_URL === "off", r.out + r.err);
  }
  const written = allText(join(home, ".codex")) + allText(join(home, ".openclaw")) + allText(join(home, ".nomad"));
  check("the seed, the backup and the RPC key are nowhere in what Nomad wrote", ![SEED, CIPHERTEXT, RPC_WITH_KEY].some((s) => written.includes(s)));
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nOstra checks passed.");
process.exit(failed ? 1 : 0);
