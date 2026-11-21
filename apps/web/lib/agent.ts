/** Nomad AI: its public wallets, its limits and how its live activity is read from Robinhood Chain. */
import { EXPLORER } from "./token";

export const AGENT_WALLETS = [
  {
    id: "oak",
    name: "Oak wallet",
    role: "Swaps against USDG through Oak",
    address: "0x60cf07B939ABC4844C9b22ea63c6aaE426a06DE7",
    detail: "Agent identity #26287 (ERC-8004), verified on Robinhood Chain",
    profile: null as string | null
  },
  {
    id: "rushr",
    name: "Rushr wallet",
    role: "Buys and sells on Rushr against ETH",
    address: "0xF965596B6b9e76Ec08c2DD2147AC88f72E9eBA4a",
    detail: "Registered on Rushr as the agent nomad_ai",
    profile: "https://rushr.trade/nomad_ai"
  }
] as const;

export type AgentWallet = (typeof AGENT_WALLETS)[number];

export const AGENT_LIMITS = {
  perTradeUsd: 0.3,
  tradesPerDay: 2,
  maxImpactPct: 2,
  startingUsdg: 10
} as const;

export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;
export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
const API = `${EXPLORER}/api/v2`;

export type Holding = { symbol: string; amount: number; usd: number | null; address: string | null };
export type WalletState = { wallet: AgentWallet; eth: number; ethUsd: number | null; holdings: Holding[]; identityNfts: number };
export type Activity = {
  hash: string;
  time: string;
  walletId: AgentWallet["id"];
  kind: "trade" | "funding" | "identity" | "other";
  text: string;
  ok: boolean;
};
export type AgentSnapshot = { wallets: WalletState[]; activity: Activity[]; ethPrice: number | null; fetchedAt: string };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const lc = (v: unknown) => str(v).toLowerCase();

/** A base-unit amount as a number, for display. */
export function units(value: unknown, decimals: unknown): number {
  const raw = str(value);
  const d = Number(decimals ?? 18);
  if (!/^\d+$/.test(raw) || !Number.isFinite(d)) return 0;
  const s = raw.padStart(d + 1, "0");
  return Number(`${s.slice(0, s.length - d)}.${s.slice(s.length - d) || "0"}`);
}

/** Up to 6 significant digits, no trailing zeros. */
export function fmt(n: number, max = 6): string {
  if (n === 0) return "0";
  if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return Number(n.toPrecision(max)).toString();
}
export const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const r = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} from the explorer`);
  return r.json();
}

/** One wallet's balances, transactions and token transfers, from the public explorer. */
async function readWallet(wallet: AgentWallet, signal?: AbortSignal) {
  const a = wallet.address;
  const [info, tokens, txs, transfers] = await Promise.all([
    getJson(`${API}/addresses/${a}`, signal),
    getJson(`${API}/addresses/${a}/token-balances`, signal),
    getJson(`${API}/addresses/${a}/transactions`, signal),
    getJson(`${API}/addresses/${a}/token-transfers`, signal)
  ]);
  const i = obj(info);
  const ethPrice = Number(i.exchange_rate) || null;
  const eth = units(i.coin_balance, 18);
  const holdings: Holding[] = [];
  let identityNfts = 0;
  for (const t of Array.isArray(tokens) ? tokens : []) {
    const tok = obj(obj(t).token);
    if (tok.decimals == null || str(tok.type).includes("721")) {
      identityNfts += 1;
      continue;
    }
    const amount = units(obj(t).value, tok.decimals);
    const rate = Number(tok.exchange_rate);
    holdings.push({ symbol: str(tok.symbol) || "token", amount, usd: Number.isFinite(rate) && tok.exchange_rate != null ? amount * rate : null, address: str(tok.address_hash || tok.address) || null });
  }
  const state: WalletState = { wallet, eth, ethUsd: ethPrice ? eth * ethPrice : null, holdings, identityNfts };
  return { state, ethPrice, activity: activityFor(wallet, txs, transfers) };
}

/** Transactions and token transfers grouped by transaction, described in plain words. */
export function activityFor(wallet: AgentWallet, txs: unknown, transfers: unknown): Activity[] {
  const me = wallet.address.toLowerCase();
  const byHash = new Map<string, { time: string; ok: boolean; method: string; ethIn: number; ethOut: number; tokIn: string[]; tokOut: string[]; registry: boolean }>();
  const entry = (hash: string, time: string) => {
    let e = byHash.get(hash);
    if (!e) byHash.set(hash, (e = { time, ok: true, method: "", ethIn: 0, ethOut: 0, tokIn: [], tokOut: [], registry: false }));
    if (time && (!e.time || time > e.time)) e.time = time;
    return e;
  };
  for (const t of Array.isArray(obj(txs).items) ? (obj(txs).items as unknown[]) : []) {
    const x = obj(t);
    const hash = str(x.hash);
    if (!hash) continue;
    const e = entry(hash, str(x.timestamp));
    e.ok = str(x.status) !== "error";
    e.method = str(x.method);
    const value = units(x.value, 18);
    if (lc(obj(x.from).hash) === me) e.ethOut += value;
    if (lc(obj(x.to).hash) === me) e.ethIn += value;
    if (e.method === "register") e.registry = true;
  }
  for (const t of Array.isArray(obj(transfers).items) ? (obj(transfers).items as unknown[]) : []) {
    const x = obj(t);
    const hash = str(x.transaction_hash);
    if (!hash) continue;
    const e = entry(hash, str(x.timestamp));
    const tok = obj(x.token);
    if (tok.decimals == null) continue; // the identity NFT, described by its registration
    const label = `${fmt(units(obj(x.total).value, tok.decimals))} ${str(tok.symbol) || "tokens"}`;
    if (lc(obj(x.to).hash) === me) e.tokIn.push(label);
    if (lc(obj(x.from).hash) === me) e.tokOut.push(label);
  }
  const out: Activity[] = [];
  for (const [hash, e] of byHash) {
    const gaveEth = e.ethOut > 0 ? `${fmt(e.ethOut)} ETH` : "";
    const gotEth = e.ethIn > 0 ? `${fmt(e.ethIn)} ETH` : "";
    const gave = [...e.tokOut, gaveEth].filter(Boolean).join(" and ");
    const got = [...e.tokIn, gotEth].filter(Boolean).join(" and ");
    let kind: Activity["kind"] = "other";
    let text: string;
    if (e.registry) {
      kind = "identity";
      text = "Registered its public agent identity";
    } else if (gave && got) {
      kind = "trade";
      text = `Traded ${gave} for ${got}`;
    } else if (got && !e.method) {
      kind = "funding";
      text = `Received ${got}`;
    } else if (got) {
      kind = "trade";
      text = `Received ${got}`;
    } else if (gave) {
      kind = e.method ? "trade" : "other";
      text = e.method ? `Paid ${gave} (${e.method})` : `Sent ${gave}`;
    } else {
      text = e.method ? `Called ${e.method}` : "Transaction";
    }
    out.push({ hash, time: e.time, walletId: wallet.id, kind, text, ok: e.ok });
  }
  return out;
}

/** Everything the Nomad AI page shows, read live from the public explorer. */
export async function readAgent(signal?: AbortSignal): Promise<AgentSnapshot> {
  const results = await Promise.all(AGENT_WALLETS.map((w) => readWallet(w, signal)));
  const activity = results.flatMap((r) => r.activity).sort((a, b) => (a.time < b.time ? 1 : -1));
  return { wallets: results.map((r) => r.state), activity, ethPrice: results.find((r) => r.ethPrice)?.ethPrice ?? null, fetchedAt: new Date().toISOString() };
}

/** Trades made in the current UTC day (the daily limit counts by UTC day). */
export function tradesToday(activity: Activity[], now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  return activity.filter((a) => a.kind === "trade" && a.ok && a.time.slice(0, 10) === day).length;
}
