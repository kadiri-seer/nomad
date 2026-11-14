/**
 * Holder voting: pure logic shared by the website API, the GitHub round jobs and the tests.
 *
 * A round has a fixed ballot and a balance snapshot taken when it opens. A vote is a message
 * signed by the voter's wallet (no transaction, no fee). Its weight is the wallet's balance in
 * the snapshot, so tokens bought or moved during a round change nothing.
 */
export type RoundOption = {
  /** Stable id: the GitHub issue number of the suggestion, as a string. */
  id: string;
  label: string;
  issue: number;
};

export type RoundResult = {
  finalizedAt: string;
  totals: Record<string, string>;
  voters: Record<string, number>;
  totalWeight: string;
  voterCount: number;
  winner: string | null;
  rejected: number;
};

export type Round = {
  id: number;
  title: string;
  opensAt: string;
  closesAt: string;
  token: { address: string; symbol: string; decimals: number };
  snapshot: { takenAt: string; source: string; block: number | null; holders: number; totalWeight: string };
  options: RoundOption[];
  excluded: string[];
  roundIssue: number | null;
  result: RoundResult | null;
};

/** Balance per lowercase address, in the token's smallest unit, as a decimal string. */
export type Holders = Record<string, string>;

export type Vote = {
  round: number;
  address: string;
  choice: string;
  signature: string;
  weight: string;
  votedAt: string;
};

export type RoundStatus = "upcoming" | "open" | "closed";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

export function normalizeAddress(value: string): string {
  if (!isAddress(value)) throw new Error("Not a wallet address");
  return value.toLowerCase();
}

export function roundStatus(round: Pick<Round, "opensAt" | "closesAt"> & { result?: RoundResult | null }, now = new Date()): RoundStatus {
  if (round.result) return "closed";
  const t = now.getTime();
  if (t < Date.parse(round.opensAt)) return "upcoming";
  if (t >= Date.parse(round.closesAt)) return "closed";
  return "open";
}

/** The exact text a voter signs. The server rebuilds it from the round, so it cannot be swapped. */
export function voteMessage(round: Pick<Round, "id" | "token">, option: RoundOption, address: string): string {
  return [`Nomad vote`, `Round: ${round.id}`, `Choice: #${option.issue} ${option.label}`, `Wallet: ${normalizeAddress(address)}`, `Weight: ${round.token.symbol} held when the round opened`].join("\n");
}

export function weightOf(round: Pick<Round, "excluded">, holders: Holders, address: string): bigint {
  const a = normalizeAddress(address);
  if (round.excluded.some((x) => x.toLowerCase() === a)) return 0n;
  const raw = holders[a];
  if (!raw || !/^\d+$/.test(raw)) return 0n;
  return BigInt(raw);
}

export function isExcluded(round: Pick<Round, "excluded">, address: string): boolean {
  const a = normalizeAddress(address);
  return round.excluded.some((x) => x.toLowerCase() === a);
}

export type Tally = {
  totals: Record<string, bigint>;
  voters: Record<string, number>;
  totalWeight: bigint;
  voterCount: number;
  winner: string | null;
};

/**
 * Adds up votes. Weights always come from the snapshot, never from the stored vote.
 * The option with the most weight wins; a tie goes to the option with more voters,
 * then to the older suggestion (lower issue number). No votes means no winner.
 */
export function tally(round: Round, holders: Holders, votes: Pick<Vote, "address" | "choice">[]): Tally {
  const totals: Record<string, bigint> = {};
  const voters: Record<string, number> = {};
  for (const o of round.options) {
    totals[o.id] = 0n;
    voters[o.id] = 0;
  }
  const seen = new Set<string>();
  let totalWeight = 0n;
  let voterCount = 0;
  for (const v of votes) {
    if (!isAddress(v.address) || !(v.choice in totals)) continue;
    const a = v.address.toLowerCase();
    if (seen.has(a)) continue;
    seen.add(a);
    const w = weightOf(round, holders, a);
    if (w === 0n) continue;
    totals[v.choice] += w;
    voters[v.choice] += 1;
    totalWeight += w;
    voterCount += 1;
  }
  let winner: string | null = null;
  if (totalWeight > 0n) {
    const ranked = [...round.options].sort((x, y) => {
      const dx = totals[y.id] - totals[x.id];
      if (dx !== 0n) return dx > 0n ? 1 : -1;
      if (voters[y.id] !== voters[x.id]) return voters[y.id] - voters[x.id];
      return x.issue - y.issue;
    });
    winner = ranked[0].id;
  }
  return { totals, voters, totalWeight, voterCount, winner };
}

export function tallyToJson(t: Tally) {
  return {
    totals: Object.fromEntries(Object.entries(t.totals).map(([k, v]) => [k, v.toString()])),
    voters: t.voters,
    totalWeight: t.totalWeight.toString(),
    voterCount: t.voterCount,
    winner: t.winner
  };
}

/** Formats a raw token amount for people: 1234567 with 6 decimals reads 1.23. */
export function formatAmount(raw: string | bigint, decimals: number, maxFraction = 2): string {
  const v = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const wholeText = whole.toLocaleString("en-US");
  if (maxFraction === 0 || frac === 0n) return wholeText;
  const fracText = frac.toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return fracText ? `${wholeText}.${fracText}` : wholeText;
}

/** Share of the total as a percentage with one decimal, safe for huge numbers. */
export function percent(part: bigint, total: bigint): number {
  if (total === 0n) return 0;
  return Number((part * 1000n) / total) / 10;
}
