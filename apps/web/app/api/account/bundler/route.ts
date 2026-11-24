/**
 * The account pages' way to Alchemy's bundler on Robinhood Chain, so the API key stays on the server. Only the
 * ERC-4337 bundler methods pass, and only for the v0.7 EntryPoint.
 */
import { bundlerCall, json, rateLimited } from "@/lib/server/account-routes";
import { ENTRY_POINT, PAYMASTER } from "@/lib/accounts/chain";

export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt",
  "eth_getUserOperationByHash",
  "eth_supportedEntryPoints",
  "eth_chainId",
  "rundler_maxPriorityFeePerGas"
]);
const NEEDS_ENTRY_POINT = new Set(["eth_sendUserOperation", "eth_estimateUserOperationGas"]);

export async function POST(req: Request) {
  let body: { id?: unknown; method?: unknown; params?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Not JSON." } }, 400);
  }
  const id = body.id ?? null;
  const method = String(body.method ?? "");
  const params = Array.isArray(body.params) ? body.params : [];
  if (!ALLOWED.has(method)) return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is not available here.` } });
  if (NEEDS_ENTRY_POINT.has(method) && String(params[1] ?? "").toLowerCase() !== ENTRY_POINT.toLowerCase()) {
    return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Only the v0.7 EntryPoint is supported." } });
  }
  if (await rateLimited(req, "bundler", 120)) return json({ jsonrpc: "2.0", id, error: { code: -32005, message: "Too many requests. Wait a minute and try again." } }, 429);
  // Only operations paid through Nomad's paymaster are sent: this route is for Nomad accounts, not a free bundler.
  if (method === "eth_sendUserOperation") {
    const op = (params[0] ?? {}) as { paymaster?: unknown };
    if (!PAYMASTER || String(op.paymaster ?? "").toLowerCase() !== PAYMASTER.toLowerCase()) return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Only operations paid through Nomad are sent here." } });
  }
  if (!process.env.ALCHEMY_RPC_URL?.trim()) return json({ jsonrpc: "2.0", id, error: { code: -32001, message: "Transactions are not set up on this site yet." } });
  try {
    const r = await bundlerCall(method, params);
    return json({ jsonrpc: "2.0", id, ...(r.error ? { error: r.error } : { result: r.result }) });
  } catch (e) {
    console.error("bundler", (e as Error).message);
    return json({ jsonrpc: "2.0", id, error: { code: -32603, message: "The bundler did not answer. Try again.", data: (e as Error).message.match(/^HTTP \d+/)?.[0] ?? "no answer" } });
  }
}
