#!/usr/bin/env node
// Checks Nomad's Tokyo Futuro support with Tokyo's real servers and the real OpenClaw, in a throwaway home:
// 1. Tokyo's hosted server answers and lists its tools, with no key and no sign-in.
// 2. Tokyo's npm package starts with no wallet key and lists its tools. Nothing is signed or sent.
// 3. An agent exported as a folder (persona, rules, notes, Tokyo's skill and .mcp.json) is moved into
//    OpenClaw, which accepts its config and lists the server; the notes arrive and a planted sign-in
//    token does not.
// Run after `pnpm build:cli`, with openclaw on PATH or in NOMAD_APPS_BIN.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/nomad.js");
const bin = (name) => (process.env.NOMAD_APPS_BIN ? join(process.env.NOMAD_APPS_BIN, name) : name);
const VERSION = process.env.TOKYO_MCP_VERSION ?? "0.2.0";
const TOKYO_URL = "https://tokyofuturo-syndicates.gate-server.workers.dev";
// Fake, shaped like Tokyo's sign-in token (<wallet>.<expiry>.<epoch>.<hmac>).
const FAKE_TOKEN = "0x2d6f3da021226fc62579099d05b1a27f72484081.1795497600.3.k3J9xQ2mP7vR4tW8yZ1bC5dF6gH0jL2n";
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nomad-check", version: "1.0" } } };
const home = mkdtempSync(join(tmpdir(), "nomad-tokyo-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, NOMAD_FAKE_HOME: home, NOMAD_HOME: join(home, ".nomad"), NO_COLOR: "1", CI: "1" };
delete env.AGENT_KEY;
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
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    out += statSync(p).isDirectory() ? allText(p) : readIf(p);
  }
  return out;
};

/** A JSON-RPC answer from a Streamable HTTP response, which may be plain JSON or server-sent events. */
async function rpcAnswer(res, id) {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const m = JSON.parse(line.slice(5));
        if (m.id === id) return m;
      } catch {
        /* not JSON */
      }
    }
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function hosted(url) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await fetch(url, { method: "POST", headers, body: JSON.stringify(INIT), signal: AbortSignal.timeout(30000) });
  const answer = await rpcAnswer(init, 1);
  const session = init.headers.get("mcp-session-id");
  const h = { ...headers, ...(session ? { "mcp-session-id": session } : {}), "mcp-protocol-version": answer?.result?.protocolVersion ?? "2025-06-18" };
  await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal: AbortSignal.timeout(30000) });
  const list = await rpcAnswer(await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), signal: AbortSignal.timeout(30000) }), 2);
  return { status: init.status, server: answer?.result?.serverInfo?.name, tools: (list?.result?.tools ?? []).map((t) => t.name) };
}

function local() {
  return new Promise((done) => {
    const p = spawn("npx", ["-y", `tokyo-futuro-mcp@${VERSION}`], { cwd: home, env: { ...env, TOKYO_URL, AGENT_NAME: "Nomad check" }, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
    let buf = "";
    let err = "";
    const finish = (r) => {
      clearTimeout(timer);
      p.kill();
      done(r);
    };
    const timer = setTimeout(() => finish({ tools: [], err: `timed out. ${err}` }), 120000);
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
  // 1. The hosted server.
  const h = await hosted(`${TOKYO_URL}/mcp`).catch((e) => ({ status: 0, tools: [], server: String(e) }));
  check(`hosted server answers (${h.server ?? "no name"}, ${h.tools.length} tools) without a key`, h.status === 200 && h.tools.length > 0, JSON.stringify(h));
  for (const n of ["join", "wallet_nonce", "wallet_login"]) check(`hosted server offers ${n}`, h.tools.includes(n), h.tools.join(", "));

  // 2. The npm package, with no wallet key.
  const l = await local();
  check(`tokyo-futuro-mcp@${VERSION} lists its tools (${l.tools.length}) with no wallet key`, l.tools.length > 0, l.err);
  for (const n of ["tokyo_take_job", "tokyo_deliver_job", "tokyo_post_decision", "tokyo_post_note", "tokyo_my_notes"]) check(`tokyo-futuro-mcp@${VERSION} offers ${n}`, l.tools.includes(n), l.tools.join(", "));

  // 3. An agent folder into the real OpenClaw.
  const folder = join(home, "diego");
  mkdirSync(join(folder, "memory"), { recursive: true });
  mkdirSync(join(folder, "skills/tokyo-futuro"), { recursive: true });
  writeFileSync(join(folder, "SOUL.md"), "You are a citizen of Tokyo Futuro.\n");
  writeFileSync(join(folder, "AGENTS.md"), "# Citizen\n\n- Wake, read your notes, take at most one job, then write a note.\n");
  writeFileSync(join(folder, "memory/notes.md"), `- Nomad check note: try non-audit jobs next.\n- Session token ${FAKE_TOKEN}\n`);
  writeFileSync(join(folder, "skills/tokyo-futuro/SKILL.md"), "---\nname: tokyo-futuro\ndescription: Act in Tokyo Futuro.\n---\n\nNever sign or send anything without approval.\n");
  writeFileSync(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { "tokyo-futuro": { command: "npx", args: ["-y", `tokyo-futuro-mcp@${VERSION}`], env: { TOKYO_URL, AGENT_KEY: "${AGENT_KEY}", AGENT_NAME: "Citizen" } } } }));
  // Named as an agent folder: AGENTS.md alone would also match other apps' layouts. The folder's server
  // is a command OpenClaw will start, so the move needs --approve-commands.
  const refused = run(process.execPath, [cli, "migrate", "--from", `generic:${folder}`, "--to", "openclaw", "-y"]);
  check("without --approve-commands the move is refused", refused.code !== 0 && /approve-commands/.test(refused.out + refused.err), refused.out + refused.err);
  const m = run(process.execPath, [cli, "migrate", "--from", `generic:${folder}`, "--to", "openclaw", "-y", "--approve-commands"]);
  check("nomad moved the agent folder to OpenClaw", m.code === 0, m.out + m.err);
  const v = run(bin("openclaw"), ["config", "validate"]);
  check("openclaw accepts its config", v.code === 0, v.out + v.err);
  const list = run(bin("openclaw"), ["mcp", "list", "--json"]);
  const by = json(list.out) ?? {};
  const file = json(readIf(join(home, ".openclaw/openclaw.json"))) ?? {};
  const server = file?.mcp?.servers?.["tokyo-futuro"];
  check("openclaw lists Tokyo's server with its pin", JSON.stringify(by["tokyo-futuro"]?.args) === JSON.stringify(["-y", `tokyo-futuro-mcp@${VERSION}`]), list.out + list.err);
  check("TOKYO_URL and AGENT_NAME arrive; AGENT_KEY is not written", server?.env?.TOKYO_URL === TOKYO_URL && server?.env?.AGENT_NAME === "Citizen" && !("AGENT_KEY" in (server?.env ?? {})), JSON.stringify(server));
  const ws = join(home, ".openclaw/workspace");
  check("the persona, rules, notes and skill arrive", readIf(join(ws, "SOUL.md")).includes("citizen of Tokyo Futuro") && readIf(join(ws, "AGENTS.md")).includes("take at most one job") && readIf(join(ws, "MEMORY.md")).includes("Nomad check note") && readIf(join(ws, "skills/tokyo-futuro/SKILL.md")).includes("Never sign"));
  check("the sign-in token in the notes was not written anywhere", !allText(join(home, ".openclaw")).includes(FAKE_TOKEN) && !allText(join(home, ".nomad")).includes(FAKE_TOKEN));
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nTokyo Futuro checks passed.");
process.exit(failed ? 1 : 0);
