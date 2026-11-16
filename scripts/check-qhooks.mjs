#!/usr/bin/env node
// Checks that QHooks' hosted server answers the way Nomad's QHooks profile expects, through the address
// Nomad writes (https://qhooks.com/mcp?ref=nomad): it lists its tools, including the ones the referral
// note names. Then, for information only, it asks for one unsigned sample trade without a referrer to see
// whether QHooks fills in Nomad's referrer for that address, and reads agent_stats for Nomad's wallet.
// Keyless; nothing is signed or sent, and nothing is written anywhere. Runs in the Real apps workflow.

const URL_NOMAD = "https://qhooks.com/mcp?ref=nomad";
const REFERRER = "0xD4bA760227cdDCD879c9d05Fbd908eb69b50dD7c";
// A burn address as the sample trader: the sample trade is never signed and could not be sent by anyone.
const SAMPLE_TRADER = "0x000000000000000000000000000000000000dEaD";
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nomad-check", version: "1.0" } } };
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
  if (!ok) failed++;
};
const info = (label) => console.log(`info ${label}`);

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

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
let h = headers;
let nextId = 10;
async function call(method, params) {
  const id = nextId++;
  const res = await fetch(URL_NOMAD, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(30000) });
  return { status: res.status, answer: await rpcAnswer(res, id) };
}
const tool = async (name, args) => (await call("tools/call", { name, arguments: args })).answer;
const content = (a) => (a?.result?.structuredContent ? JSON.stringify(a.result.structuredContent) : (a?.result?.content ?? []).map((c) => c.text ?? "").join("\n"));

const init = await fetch(URL_NOMAD, { method: "POST", headers, body: JSON.stringify(INIT), signal: AbortSignal.timeout(30000) });
const hello = await rpcAnswer(init, 1);
const session = init.headers.get("mcp-session-id");
h = { ...headers, ...(session ? { "mcp-session-id": session } : {}), "mcp-protocol-version": hello?.result?.protocolVersion ?? "2025-06-18" };
await fetch(URL_NOMAD, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal: AbortSignal.timeout(30000) });
check(`QHooks answers at ${URL_NOMAD} (${hello?.result?.serverInfo?.name ?? "no name"})`, init.status === 200 && !!hello?.result, `HTTP ${init.status}`);

const list = await call("tools/list", {});
const tools = list.answer?.result?.tools ?? [];
const names = tools.map((t) => t.name);
check(`it lists its tools without a key (${names.length})`, names.length > 0, JSON.stringify(list.answer ?? list.status));
for (const n of ["list_launches", "prepare_trade", "prepare_launch"]) check(`it offers ${n}`, names.includes(n), names.join(", "));
const referrerInput = (n) => !!tools.find((t) => t.name === n)?.inputSchema?.properties?.referrer;
check("prepare_trade and prepare_launch take a referrer, as the referral note asks", referrerInput("prepare_trade") && referrerInput("prepare_launch"), JSON.stringify(tools.filter((t) => /^prepare_(trade|launch)$/.test(t.name)).map((t) => [t.name, Object.keys(t.inputSchema?.properties ?? {})])));

// For information: does the ?ref=nomad address alone credit Nomad? Not a failure until QHooks confirms it does.
try {
  const launches = await tool("list_launches", { chain: "4663", limit: 1 });
  const token = (content(launches).match(/0x[0-9a-fA-F]{40}/) ?? [])[0];
  if (!token) info("no Robinhood Chain launch to build a sample trade with");
  else {
    const sample = await tool("prepare_trade", { chain: "4663", token, side: "buy", amountIn: "0.0001", trader: SAMPLE_TRADER });
    const text = content(sample) + JSON.stringify(sample?.error ?? "");
    info(text.toLowerCase().includes(REFERRER.toLowerCase().slice(2))
      ? "a sample trade through ?ref=nomad without a referrer names Nomad's referrer"
      : `a sample trade through ?ref=nomad without a referrer does not name Nomad's referrer${sample?.error || sample?.result?.isError ? ` (QHooks said: ${text.slice(0, 300)})` : ""}`);
  }
} catch (e) {
  info(`sample trade not checked: ${e}`);
}
if (names.includes("agent_stats")) {
  try {
    info(`agent_stats for Nomad's referrer: ${content(await tool("agent_stats", { referrer: REFERRER })).slice(0, 400)}`);
  } catch (e) {
    info(`agent_stats not read: ${e}`);
  }
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nQHooks answers as Nomad expects.");
process.exit(failed ? 1 : 0);
