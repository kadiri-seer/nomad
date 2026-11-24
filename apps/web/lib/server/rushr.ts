/**
 * Rushr's public API (https://api.rushr.trade), as Nomad's agents use it: reads that need no key (market data, safety,
 * the callout feed, the leaderboard). Nothing here signs, trades or posts. Rushr's safety verdict is a second check on
 * every token an agent may buy; the other reads are research tools. Answers are data, capped in size.
 */
import type { FunctionDeclaration } from "./agent-tools";

export const RUSHR_API = "https://api.rushr.trade";
type FetchLike = typeof fetch;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type RushrSafety = { riskLevel: "low" | "medium" | "high" | "unknown"; blocked: boolean; flags: string[] };

async function getJson(fetchImpl: FetchLike, path: string): Promise<unknown> {
  const r = await fetchImpl(`${RUSHR_API}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000), cache: "no-store", redirect: "error" });
  const text = await r.text();
  if (text.length > 400_000) throw new Error("answer too large");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(text);
}

/** Rushr's safety verdict on a token, or null when Rushr has no verdict (not indexed, or not reachable). */
export async function rushrSafety(address: string, fetchImpl: FetchLike = fetch): Promise<RushrSafety | null> {
  if (!ADDRESS.test(address)) return null;
  try {
    const j = (await getJson(fetchImpl, `/v1/tokens/${address}/safety`)) as { safety?: { riskLevel?: string; blocked?: boolean; flags?: unknown[] } };
    const s = j.safety;
    if (!s) return null;
    const level = ["low", "medium", "high"].includes(String(s.riskLevel)) ? (s.riskLevel as RushrSafety["riskLevel"]) : "unknown";
    const flags = (Array.isArray(s.flags) ? s.flags : []).map((f) => (typeof f === "string" ? f : typeof f === "object" && f ? String((f as Record<string, unknown>).code ?? (f as Record<string, unknown>).label ?? "") : "")).filter(Boolean).slice(0, 6);
    return { riskLevel: level, blocked: s.blocked === true, flags: flags.map((f) => f.replace(/[^\w .:-]/g, "").slice(0, 40)) };
  } catch {
    return null;
  }
}

/** Rushr's reads as research tools, each with a fixed path and checked arguments. */
type LocalTool = { declaration: FunctionDeclaration; path(args: Record<string, unknown>): string | null };
const addr = { type: "string", description: "Token address on Robinhood Chain (0x and 40 hex digits)" };
const pick = (v: unknown, allowed: string[], dflt: string) => (typeof v === "string" && allowed.includes(v) ? v : dflt);
const limit = (v: unknown, max: number, dflt: number) => Math.max(1, Math.min(max, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : dflt));

export const RUSHR_TOOLS: Record<string, LocalTool> = {
  tokens: {
    declaration: { name: "rushr_tokens", description: "Rushr: tokens on Rushr's launchpads with price, market cap, 24h volume, liquidity, holders and risk. column: new, almost (close to leaving the bonding curve) or migrated.", parameters: { type: "object", properties: { column: { type: "string", enum: ["new", "almost", "migrated"] } } } },
    path: (a) => `/tokens?column=${pick(a.column, ["new", "almost", "migrated"], "migrated")}`
  },
  token: {
    declaration: { name: "rushr_token", description: "Rushr: market data for one token.", parameters: { type: "object", properties: { address: addr }, required: ["address"] } },
    path: (a) => (ADDRESS.test(String(a.address)) ? `/tokens/${a.address}` : null)
  },
  safety: {
    declaration: { name: "rushr_token_safety", description: "Rushr: its safety verdict on a token (risk level, flags, whether Rushr blocks it).", parameters: { type: "object", properties: { address: addr }, required: ["address"] } },
    path: (a) => (ADDRESS.test(String(a.address)) ? `/v1/tokens/${a.address}/safety` : null)
  },
  signals: {
    declaration: { name: "rushr_token_signals", description: "Rushr: safety signals for a token, including its buy and sell taxes.", parameters: { type: "object", properties: { address: addr }, required: ["address"] } },
    path: (a) => (ADDRESS.test(String(a.address)) ? `/tokens/${a.address}/signals` : null)
  },
  callouts: {
    declaration: { name: "rushr_token_callouts", description: "Rushr: traders' public calls on one token, newest first, with their stance and how the call has done.", parameters: { type: "object", properties: { address: addr, limit: { type: "integer" } }, required: ["address"] } },
    path: (a) => (ADDRESS.test(String(a.address)) ? `/v1/tokens/${a.address}/callouts?limit=${limit(a.limit, 20, 10)}` : null)
  },
  feed: {
    declaration: { name: "rushr_feed", description: "Rushr: the latest public calls from traders, newest first.", parameters: { type: "object", properties: { limit: { type: "integer" } } } },
    path: (a) => `/v1/feed?limit=${limit(a.limit, 30, 20)}`
  },
  leaderboard: {
    declaration: { name: "rushr_leaderboard", description: "Rushr: the traders' leaderboard with profit, return, win rate and volume. window: 24h, 7d, 30d or season; kind: all, human or agent.", parameters: { type: "object", properties: { window: { type: "string", enum: ["24h", "7d", "30d", "season"] }, kind: { type: "string", enum: ["all", "human", "agent"] }, limit: { type: "integer" } } } },
    path: (a) => `/v1/leaderboard?window=${pick(a.window, ["24h", "7d", "30d", "season"], "24h")}&kind=${pick(a.kind, ["all", "human", "agent"], "all")}&limit=${limit(a.limit, 50, 20)}`
  },
  stocks: {
    declaration: { name: "rushr_stocks", description: "Rushr: stock tokens on Robinhood Chain with price, 24h change, volume and liquidity." },
    path: () => "/stocks"
  },
  search: {
    declaration: { name: "rushr_search", description: "Rushr: search tokens by ticker, name or address.", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    path: (a) => (typeof a.q === "string" && a.q.trim() && a.q.length <= 64 ? `/search?q=${encodeURIComponent(a.q.trim())}` : null)
  }
};

/** Runs one of Rushr's read tools: the answer as text, or why it was not run. */
export async function runRushrTool(name: string, args: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<string> {
  const t = Object.values(RUSHR_TOOLS).find((x) => x.declaration.name === name);
  if (!t) return "Not run: there is no tool by that name.";
  const path = t.path(args);
  if (!path) return "Not run: give a token address (0x and 40 hex digits), or a search of at most 64 characters.";
  return JSON.stringify(await getJson(fetchImpl, path));
}
