/**
 * Balance snapshots taken when a round opens. Two independent sources:
 * the Blockscout explorer's holder list, and, if that fails, replaying the token's
 * Transfer events from the chain. Either way the result is published with the round,
 * so anyone can check it.
 */
import type { Holders } from "./core";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Builds balances from Blockscout `/api/v2/tokens/{address}/holders` pages. */
export function holdersFromBlockscoutItems(items: unknown[]): Holders {
  const out: Holders = {};
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { address?: unknown; value?: unknown };
    const addr = typeof rec.address === "string" ? rec.address : rec.address && typeof rec.address === "object" ? (rec.address as { hash?: unknown }).hash : undefined;
    if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
    if (typeof rec.value !== "string" || !/^\d+$/.test(rec.value)) continue;
    if (rec.value === "0") continue;
    out[addr.toLowerCase()] = rec.value;
  }
  return out;
}

export async function fetchBlockscoutHolders(explorer: string, token: string, fetchImpl: FetchLike = fetch, maxPages = 2000): Promise<Holders> {
  const items: unknown[] = [];
  let params: Record<string, unknown> | null = {};
  let pages = 0;
  while (params) {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const url = `${explorer.replace(/\/$/, "")}/api/v2/tokens/${token}/holders${qs ? `?${qs}` : ""}`;
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Explorer answered ${res.status} for the holder list`);
    const body = (await res.json()) as { items?: unknown[]; next_page_params?: Record<string, unknown> | null };
    if (!Array.isArray(body.items)) throw new Error("Explorer holder list has no items");
    items.push(...body.items);
    params = body.next_page_params && Object.keys(body.next_page_params).length ? body.next_page_params : null;
    pages += 1;
    if (pages >= maxPages) throw new Error("Explorer holder list is longer than expected");
  }
  return holdersFromBlockscoutItems(items);
}

export type TransferLog = { topics: string[]; data: string; blockNumber?: string; logIndex?: string };

/** Replays Transfer events into balances. Logs must be in chain order. */
export function holdersFromTransferLogs(logs: TransferLog[]): Holders {
  const bal = new Map<string, bigint>();
  for (const log of logs) {
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const from = ("0x" + log.topics[1].slice(-40)).toLowerCase();
    const to = ("0x" + log.topics[2].slice(-40)).toLowerCase();
    const value = BigInt(log.data && log.data !== "0x" ? log.data : "0x0");
    if (from !== ZERO) bal.set(from, (bal.get(from) ?? 0n) - value);
    if (to !== ZERO) bal.set(to, (bal.get(to) ?? 0n) + value);
  }
  const out: Holders = {};
  for (const [a, v] of bal) if (v > 0n) out[a] = v.toString();
  return out;
}

export async function rpcCall<T>(rpc: string, method: string, params: unknown[], fetchImpl: FetchLike = fetch): Promise<T> {
  const res = await fetchImpl(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!res.ok) throw new Error(`RPC answered ${res.status} to ${method}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? "error"}`);
  return body.result as T;
}

/**
 * Reads every Transfer log of the token up to `toBlock`, shrinking the block range
 * when the RPC refuses a range as too large and growing it again after successes.
 */
export async function fetchTransferLogs(rpc: string, token: string, fromBlock: number, toBlock: number, fetchImpl: FetchLike = fetch, maxRequests = 20000): Promise<TransferLog[]> {
  const logs: TransferLog[] = [];
  let start = fromBlock;
  let span = Math.max(1, toBlock - fromBlock + 1);
  let requests = 0;
  while (start <= toBlock) {
    const end = Math.min(toBlock, start + span - 1);
    requests += 1;
    if (requests > maxRequests) throw new Error("Too many log requests; the RPC range limit is too small");
    try {
      const part = await rpcCall<TransferLog[]>(rpc, "eth_getLogs", [{ address: token, topics: [TRANSFER_TOPIC], fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16) }], fetchImpl);
      logs.push(...part);
      start = end + 1;
      span = Math.min(span * 2, 50_000_000);
    } catch (e) {
      if (span === 1) throw e;
      span = Math.max(1, Math.floor(span / 2));
    }
  }
  return logs;
}

export function sumHolders(h: Holders): bigint {
  let t = 0n;
  for (const v of Object.values(h)) t += BigInt(v);
  return t;
}
