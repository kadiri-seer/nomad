/**
 * Nomad's economy, read live from public sources: the treasury and revenue wallets and every $NOMAD burned (the
 * Robinhood Chain explorer), Nomad AI's running costs (its public feed), builder bounties (GitHub issues),
 * buybacks (the repo's record, each with its transaction) and minted agents (the NomadAgents contract's events).
 * Nothing here is estimated or projected: amounts are what the chain or the record shows.
 */
import { decodeEventLog, type Abi } from "viem";
import { AGENT_WALLETS, fmt, units } from "./agent";
import { EXPLORER, REWARD_SAFE, TOKEN_CA } from "./token";
import { AGENTS_ABI } from "./agents-contract";

export const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
export const NOMAD_DECIMALS = 18;
const API = `${EXPLORER}/api/v2`;
export const ECONOMY_FEED_URL = "https://raw.githubusercontent.com/kadiri-seer/nomad-ai-feed/main/economy.json";
export const ECONOMY_RECORD_URL = "https://raw.githubusercontent.com/kadiri-seer/nomad/main/governance/economy.json";
export const BOUNTIES_URL = "https://api.github.com/repos/kadiri-seer/nomad/issues?labels=bounty&state=all&per_page=50";
export const BOUNTIES_PAGE = "https://github.com/kadiri-seer/nomad/issues?q=is%3Aissue+label%3Abounty";

/** The address of the NomadAgents contract, once it is deployed (set in the site's settings), or null. */
export const AGENTS_CONTRACT: string | null = /^0x[0-9a-fA-F]{40}$/.test(process.env.NEXT_PUBLIC_AGENTS_CONTRACT ?? "") ? (process.env.NEXT_PUBLIC_AGENTS_CONTRACT as string) : null;

export type EconomyWallet = { id: string; name: string; role: string; group: "treasury" | "revenue" | "operating"; address: string };

/** Every wallet the economy page follows, in the order it shows them. */
export const ECONOMY_WALLETS: EconomyWallet[] = [
  { id: "treasury", name: "Treasury", role: "Safe multisig, two approvals to send. Pays builder bounties and holds fees from minting.", group: "treasury", address: REWARD_SAFE },
  { id: "referral", name: "QHooks referral wallet", role: "Receives Nomad's share of QHooks fees on trades routed through Nomad.", group: "revenue", address: "0xD4bA760227cdDCD879c9d05Fbd908eb69b50dD7c" },
  ...AGENT_WALLETS.map((w) => ({ id: `ai-${w.id}`, name: `Nomad AI: ${w.name}`, role: w.role, group: "operating" as const, address: w.address }))
];

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const lc = (v: unknown) => str(v).toLowerCase();
const num = (v: unknown) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : null;
};

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const r = await fetch(url, { signal, headers: { accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------- balances

export type Balance = { symbol: string; amount: number; usd: number | null; token: string | null };
export type WalletBalances = { wallet: EconomyWallet; balances: Balance[]; usd: number | null };

/** A wallet's ETH and tokens from the explorer's address and token-balances answers. NFTs are left out. */
export function parseBalances(wallet: EconomyWallet, info: unknown, tokens: unknown, nomadUsd: number | null): WalletBalances {
  const i = obj(info);
  const ethRate = num(i.exchange_rate);
  const eth = units(i.coin_balance, 18);
  const balances: Balance[] = [{ symbol: "ETH", amount: eth, usd: ethRate === null ? null : eth * ethRate, token: null }];
  for (const t of Array.isArray(tokens) ? tokens : []) {
    const tok = obj(obj(t).token);
    if (tok.decimals == null || str(tok.type).includes("721") || str(tok.type).includes("1155")) continue;
    const address = str(tok.address_hash || tok.address) || null;
    const amount = units(obj(t).value, tok.decimals);
    if (amount === 0) continue;
    const isNomad = lc(address) === lc(TOKEN_CA);
    const rate = isNomad ? (nomadUsd ?? num(tok.exchange_rate)) : num(tok.exchange_rate);
    balances.push({ symbol: isNomad ? "$NOMAD" : str(tok.symbol) || "token", amount, usd: rate === null ? null : amount * rate, token: address });
  }
  const priced = balances.filter((b) => b.usd !== null);
  return { wallet, balances, usd: priced.length ? priced.reduce((s, b) => s + (b.usd ?? 0), 0) : null };
}

// ---------------------------------------------------------------- token transfers (burns, revenue, payouts)

export type Transfer = { hash: string; time: string; from: string; to: string; symbol: string; token: string; amount: number };

/** Fungible token transfers from an explorer token-transfers answer. */
export function parseTransfers(json: unknown): Transfer[] {
  const out: Transfer[] = [];
  for (const t of Array.isArray(obj(json).items) ? (obj(json).items as unknown[]) : []) {
    const x = obj(t);
    const tok = obj(x.token);
    if (tok.decimals == null) continue;
    const hash = str(x.transaction_hash);
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) continue;
    const token = str(tok.address_hash || tok.address);
    out.push({
      hash,
      time: str(x.timestamp),
      from: str(obj(x.from).hash),
      to: str(obj(x.to).hash),
      symbol: lc(token) === lc(TOKEN_CA) ? "$NOMAD" : str(tok.symbol) || "token",
      token,
      amount: units(obj(x.total).value, tok.decimals)
    });
  }
  return out;
}

/** Totals per token symbol. */
export function sumBySymbol(list: Transfer[]): { symbol: string; amount: number }[] {
  const m = new Map<string, number>();
  for (const t of list) m.set(t.symbol, (m.get(t.symbol) ?? 0) + t.amount);
  return [...m].map(([symbol, amount]) => ({ symbol, amount })).sort((a, b) => b.amount - a.amount);
}

// ---------------------------------------------------------------- Nomad AI's running costs (its feed)

export type CostPeriod = {
  runs: number;
  aiUsd: string;
  oddsEngineChecks: number;
  oddsEngineUsd: string;
  upochTransactions: number;
  networkFeesEth: string;
  networkFeesUsd: string | null;
  payments: number;
  paymentsUsd: string;
  totalUsd: string;
  trades: number;
  tradedUsd: string;
};
export type Costs = {
  updated: string;
  month: string;
  thisMonth: CostPeriod;
  allTime: CostPeriod;
  budget: { monthlyUsd: string; usedPct: number } | null;
  payments: { time: string; name: string; amount: string; token: string; txHash: string | null }[];
};

const money = (v: unknown) => (/^\d{1,9}\.\d{2}$/.test(str(v)) ? str(v) : "0.00");
const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1e9 ? (v as number) : 0);
const plain = (v: unknown, max = 40) => str(v).replace(/[^\p{L}\p{N} .,'$()-]/gu, "").slice(0, max);
function period(v: unknown): CostPeriod {
  const p = obj(v);
  return {
    runs: count(p.runs),
    aiUsd: money(p.aiUsd),
    oddsEngineChecks: count(p.oddsEngineChecks),
    oddsEngineUsd: money(p.oddsEngineUsd),
    upochTransactions: count(p.upochTransactions),
    networkFeesEth: /^\d{1,6}(\.\d{1,18})?$/.test(str(p.networkFeesEth)) ? str(p.networkFeesEth) : "0",
    networkFeesUsd: p.networkFeesUsd === null ? null : money(p.networkFeesUsd),
    payments: count(p.payments),
    paymentsUsd: money(p.paymentsUsd),
    totalUsd: money(p.totalUsd),
    trades: count(p.trades),
    tradedUsd: money(p.tradedUsd)
  };
}

/** Nomad AI's feed, checked field by field: numbers in their shapes, names as plain text, hashes as hashes. */
export function parseCosts(json: unknown): Costs | null {
  const j = obj(json);
  if (!/^\d{4}-\d{2}$/.test(str(j.month)) || !j.thisMonth) return null;
  const b = obj(j.budget);
  return {
    updated: str(j.updated),
    month: str(j.month),
    thisMonth: period(j.thisMonth),
    allTime: period(j.allTime),
    budget: j.budget ? { monthlyUsd: money(b.monthlyUsd), usedPct: Math.min(999, count(b.usedPct)) } : null,
    payments: (Array.isArray(j.payments) ? j.payments : []).slice(0, 10).map((p) => {
      const x = obj(p);
      return { time: str(x.time), name: plain(x.name), amount: /^\d{1,30}(\.\d{1,18})?$/.test(str(x.amount)) ? str(x.amount) : "?", token: plain(x.token, 16), txHash: /^0x[0-9a-fA-F]{64}$/.test(str(x.txHash)) ? str(x.txHash) : null };
    })
  };
}

// ---------------------------------------------------------------- buybacks (the repo's record)

export type Buyback = { date: string; spent: string; bought: string; tx: string; burnTx: string | null; note: string };

/** governance/economy.json's buybacks: each must link its own transaction to count. */
export function parseBuybacks(json: unknown): Buyback[] {
  const list = obj(json).buybacks;
  if (!Array.isArray(list)) return [];
  return list
    .map((v) => obj(v))
    .filter((x) => /^0x[0-9a-fA-F]{64}$/.test(str(x.tx)) && /^\d{4}-\d{2}-\d{2}$/.test(str(x.date)))
    .map((x) => ({ date: str(x.date), spent: plain(x.spent), bought: plain(x.bought), tx: str(x.tx), burnTx: /^0x[0-9a-fA-F]{64}$/.test(str(x.burnTx)) ? str(x.burnTx) : null, note: plain(x.note, 120) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

// ---------------------------------------------------------------- bounties (GitHub issues)

export type Bounty = { number: number; title: string; url: string; state: "open" | "done"; amount: string | null; integration: string | null };

/** "### Bounty amount\n\n50000 $NOMAD" style fields from an issue form. */
function formField(body: string, label: string): string | null {
  const m = new RegExp(`###\\s*${label}\\s*\\n+([^\\n#]+)`, "i").exec(body);
  const v = m?.[1]?.trim();
  return v && v !== "_No response_" ? v.slice(0, 60) : null;
}

export function parseBounties(json: unknown): Bounty[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((v) => obj(v))
    .filter((x) => !x.pull_request && Number.isInteger(x.number))
    .map((x) => {
      const body = str(x.body);
      return {
        number: x.number as number,
        title: str(x.title).replace(/^\[Bounty\]\s*/i, "").slice(0, 100) || `Bounty #${x.number}`,
        url: /^https:\/\/github\.com\/kadiri-seer\/nomad\/issues\/\d+$/.test(str(x.html_url)) ? str(x.html_url) : `https://github.com/kadiri-seer/nomad/issues/${x.number}`,
        state: str(x.state) === "closed" ? ("done" as const) : ("open" as const),
        amount: formField(body, "Bounty amount"),
        integration: formField(body, "Integration")
      };
    });
}

// ---------------------------------------------------------------- minted agents (the contract's events)

export type MintedAgent = { id: number; name: string; creator: string; packageHash: string; uri: string; price: number; copies: number; mintedAt: string; hash: string };
export type AgentsSummary = { agents: MintedAgent[]; burned: number; toTreasury: number; toCreators: number };

/** Minted, PriceSet, UriSet and Copied events from the explorer's logs for the contract, newest agent first. */
export function agentsFromLogs(json: unknown): AgentsSummary {
  const items = (Array.isArray(obj(json).items) ? (obj(json).items as unknown[]) : []).map((v) => obj(v));
  // The explorer lists newest first; apply events oldest first.
  items.sort((a, b) => (num(a.block_number) ?? 0) - (num(b.block_number) ?? 0) || (num(a.index) ?? 0) - (num(b.index) ?? 0));
  const agents = new Map<number, MintedAgent>();
  let burned = 0;
  let toTreasury = 0;
  let toCreators = 0;
  for (const x of items) {
    const topics = (Array.isArray(x.topics) ? x.topics : []).filter((t): t is `0x${string}` => typeof t === "string" && /^0x[0-9a-fA-F]{64}$/.test(t));
    const data = str(x.data);
    if (!topics.length || !/^0x[0-9a-fA-F]*$/.test(data)) continue;
    let ev: { eventName: string; args: Record<string, unknown> };
    try {
      ev = decodeEventLog({ abi: AGENTS_ABI as Abi, topics: topics as [`0x${string}`, ...`0x${string}`[]], data: data as `0x${string}` }) as unknown as typeof ev;
    } catch {
      continue;
    }
    const a = ev.args;
    const id = Number(a.id);
    if (ev.eventName === "Minted") {
      const fee = units(String(a.fee), NOMAD_DECIMALS);
      const b = units(String(a.burned), NOMAD_DECIMALS);
      burned += b;
      toTreasury += fee - b;
      agents.set(id, { id, name: plain(a.name, 64) || `Agent ${id}`, creator: str(a.creator), packageHash: str(a.packageHash), uri: /^https:\/\/[^\s"<>]{1,250}$/.test(str(a.uri)) ? str(a.uri) : "", price: units(String(a.price), NOMAD_DECIMALS), copies: 0, mintedAt: str(x.timestamp), hash: str(x.transaction_hash) });
    } else if (ev.eventName === "PriceSet" && agents.has(id)) {
      agents.get(id)!.price = units(String(a.price), NOMAD_DECIMALS);
    } else if (ev.eventName === "UriSet" && agents.has(id)) {
      agents.get(id)!.uri = /^https:\/\/[^\s"<>]{1,250}$/.test(str(a.uri)) ? str(a.uri) : "";
    } else if (ev.eventName === "Copied" && agents.has(id)) {
      agents.get(id)!.copies += 1;
      burned += units(String(a.burned), NOMAD_DECIMALS);
      toTreasury += units(String(a.toTreasury), NOMAD_DECIMALS);
      toCreators += units(String(a.toOwner), NOMAD_DECIMALS);
    }
  }
  return { agents: [...agents.values()].sort((a, b) => b.id - a.id), burned, toTreasury, toCreators };
}

/** Every log of the contract, from the explorer (a few pages at most). */
export async function readAgents(signal?: AbortSignal, contract = AGENTS_CONTRACT): Promise<AgentsSummary | null> {
  if (!contract) return null;
  const items: unknown[] = [];
  let params: Record<string, unknown> | null = {};
  for (let page = 0; params && page < 20; page++) {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const j = obj(await getJson(`${API}/addresses/${contract}/logs${qs ? `?${qs}` : ""}`, signal));
    items.push(...(Array.isArray(j.items) ? j.items : []));
    const next = obj(j.next_page_params);
    params = Object.keys(next).length ? next : null;
  }
  return agentsFromLogs({ items });
}

// ---------------------------------------------------------------- everything at once

export type Economy = {
  nomad: { usd: number | null; supply: number | null; holders: number | null };
  wallets: WalletBalances[];
  burned: { total: number | null; recent: Transfer[] };
  revenue: { received: { symbol: string; amount: number }[]; recent: Transfer[] };
  payouts: Transfer[];
  costs: Costs | null;
  bounties: Bounty[] | null;
  buybacks: Buyback[];
  agents: AgentsSummary | null;
  errors: string[];
  fetchedAt: string;
};

const settle = async <T,>(p: Promise<T>, label: string, errors: string[]): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    errors.push(label);
    return null;
  }
};

/** Reads every source. A source that does not answer is listed in errors; the rest still shows. */
export async function readEconomy(signal?: AbortSignal): Promise<Economy> {
  const errors: string[] = [];
  const token = obj(await settle(getJson(`${API}/tokens/${TOKEN_CA}`, signal), "the $NOMAD token page", errors));
  const nomadUsd = num(token.exchange_rate);
  const supply = token.total_supply != null ? units(token.total_supply, token.decimals ?? NOMAD_DECIMALS) : null;
  const holders = num(token.holders_count ?? token.holders);

  const walletsP = Promise.all(
    ECONOMY_WALLETS.map(async (w) => {
      const [info, tokens] = await Promise.all([getJson(`${API}/addresses/${w.address}`, signal), getJson(`${API}/addresses/${w.address}/token-balances`, signal)]);
      return parseBalances(w, info, tokens, nomadUsd);
    })
  );
  const burnBalanceP = getJson(`${API}/addresses/${BURN_ADDRESS}/token-balances`, signal);
  const burnsP = getJson(`${API}/addresses/${BURN_ADDRESS}/token-transfers?type=ERC-20&filter=to&token=${TOKEN_CA}`, signal);
  const referral = ECONOMY_WALLETS.find((w) => w.id === "referral")!.address;
  const revenueP = getJson(`${API}/addresses/${referral}/token-transfers?type=ERC-20&filter=to`, signal);
  const payoutsP = getJson(`${API}/addresses/${REWARD_SAFE}/token-transfers?type=ERC-20&filter=from&token=${TOKEN_CA}`, signal);
  const costsP = getJson(ECONOMY_FEED_URL, signal);
  const bountiesP = getJson(BOUNTIES_URL, signal);
  const recordP = getJson(ECONOMY_RECORD_URL, signal);
  const agentsP = readAgents(signal);

  const [wallets, burnBalance, burns, revenue, payouts, costs, bounties, record, agents] = await Promise.all([
    settle(walletsP, "wallet balances", errors),
    settle(burnBalanceP, "the burn address", errors),
    settle(burnsP, "burns", errors),
    settle(revenueP, "referral income", errors),
    settle(payoutsP, "bounty payouts", errors),
    settle(costsP, "Nomad AI's costs feed", errors),
    settle(bountiesP, "bounties on GitHub", errors),
    settle(recordP, "the buyback record", errors),
    settle(agentsP, "minted agents", errors)
  ]);

  let burnedTotal: number | null = null;
  if (Array.isArray(burnBalance)) {
    const row = burnBalance.map((v) => obj(v)).find((t) => lc(obj(t.token).address_hash || obj(t.token).address) === lc(TOKEN_CA));
    burnedTotal = row ? units(row.value, obj(row.token).decimals ?? NOMAD_DECIMALS) : 0;
  }
  const inflows = revenue ? parseTransfers(revenue).filter((t) => lc(t.to) === lc(referral)) : [];
  return {
    nomad: { usd: nomadUsd, supply, holders },
    wallets: wallets ?? [],
    burned: { total: burnedTotal, recent: burns ? parseTransfers(burns).filter((t) => lc(t.to) === lc(BURN_ADDRESS) && lc(t.token) === lc(TOKEN_CA)).slice(0, 10) : [] },
    revenue: { received: sumBySymbol(inflows), recent: inflows.slice(0, 10) },
    payouts: payouts ? parseTransfers(payouts).filter((t) => lc(t.from) === lc(REWARD_SAFE) && lc(t.token) === lc(TOKEN_CA)).slice(0, 10) : [],
    costs: costs ? parseCosts(costs) : null,
    bounties: bounties ? parseBounties(bounties) : null,
    buybacks: record ? parseBuybacks(record) : [],
    agents,
    errors,
    fetchedAt: new Date().toISOString()
  };
}

export const tokenAmount = (n: number, symbol = "$NOMAD") => `${fmt(n)} ${symbol}`;
