#!/usr/bin/env node
// Checks that HEY Research Lab's servers answer the way Nomad's HEY profile expects: the hosted
// server and its research profile over Streamable HTTP, and the local npm package over stdio, each
// listing its tools. Read-only and keyless; nothing is written anywhere. Runs in the Real apps workflow.
import { spawn } from "node:child_process";

const VERSION = process.env.HEY_MCP_VERSION ?? "0.3.5";
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nomad-check", version: "1.0" } } };
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
  if (!ok) failed++;
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
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-hey-integration": "nomad-check/1.0" };
  const init = await fetch(url, { method: "POST", headers, body: JSON.stringify(INIT) });
  const answer = await rpcAnswer(init, 1);
  const session = init.headers.get("mcp-session-id");
  const h = { ...headers, ...(session ? { "mcp-session-id": session } : {}), "mcp-protocol-version": answer?.result?.protocolVersion ?? "2025-06-18" };
  await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const list = await rpcAnswer(await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }), 2);
  return { status: init.status, server: answer?.result?.serverInfo?.name, tools: (list?.result?.tools ?? []).map((t) => t.name) };
}

function local(profile) {
  return new Promise((done) => {
    const env = { ...process.env, ...(profile ? { HEY_MCP_PROFILE: profile } : {}) };
    delete env.HEY_API_KEY;
    const p = spawn("npx", ["-y", `@hey-research-lab/mcp@${VERSION}`], { env, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
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

const full = await hosted("https://heyresearch.xyz/mcp");
check(`hosted server answers (${full.server ?? "no name"}, ${full.tools.length} tools)`, full.status === 200 && full.tools.length > 0, JSON.stringify(full));
const research = await hosted("https://heyresearch.xyz/mcp/research");
check(`hosted research profile answers (${research.tools.length} tools)`, research.status === 200 && research.tools.length > 0, JSON.stringify(research));
check("the research profile offers no more tools than the full server", research.tools.length <= full.tools.length, `${research.tools} vs ${full.tools}`);

const localFull = await local();
check(`local server @hey-research-lab/mcp@${VERSION} lists its tools (${localFull.tools.length}) without a key`, localFull.tools.length > 0, localFull.err);
const localResearch = await local("research");
check(`local research profile lists its tools (${localResearch.tools.length})`, localResearch.tools.length > 0 && localResearch.tools.length <= localFull.tools.length, localResearch.err);

console.log(failed ? `\n${failed} check(s) failed.` : "\nHEY Research servers answer as Nomad expects.");
process.exit(failed ? 1 : 0);
