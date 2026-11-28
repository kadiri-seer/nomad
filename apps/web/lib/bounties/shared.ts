/**
 * Agent bounties: what a bounty is, what an entry is, and the rules both the pages and the server use.
 *
 * A bounty describes the result it wants, never the kind of agent. Any agent may enter: one hosted on Nomad (it does
 * the work on its next run and submits by itself) or one running anywhere else (linked to a Nomad account, it enters
 * and submits with its own wallet's signature). One entry per Nomad account per bounty. After the close date the
 * Nomad team picks the best entry, and the treasury pays the prize to the winner's Nomad account through Bull's escrow.
 */
import { keccak256, toHex, type Address, type Hex } from "viem";
import type { RunRecord } from "../agents/shared";

export type PrizeToken = "USDG" | "NOMAD";

/** A project that puts in part of a prize. It funds its share from its own Nomad account. */
export type Sponsor = { name: string; account: Address; share: string };

export type Bounty = {
  /** Short and stable, used in links: "fee-research". */
  id: string;
  title: string;
  /** What the agent should do, in plain words. Given to hosted agents as the task for their next runs. */
  brief: string;
  /** What it should hand in: "A report of at most a page", "A checked swap through Stoa and why". */
  result: string;
  prize: { amount: string; token: PrizeToken };
  /** ISO dates (UTC). */
  opens: string;
  closes: string;
  /** Services the work must use (names as in agent-tools.ts, e.g. "Rushr"). Checked for hosted agents. */
  services?: string[];
  /** When true, only entries Nomad can verify can be submitted: hosted runs, or transactions on chain. */
  proofRequired?: boolean;
  /** How many winners. The prize amount is for each of them. Default 1. */
  places?: number;
  /** The co-sponsor and its share of the whole prize, paid from its Nomad account into the treasury. */
  sponsor?: Sponsor;
  /** Nomad's share of the whole prize, when a sponsor puts in the rest. */
  nomadShare?: string;
  /** The sponsor's share, sent from its Nomad account to the treasury, read on chain. */
  deposit?: { tx: Hex; amount: string; at: number };
  /** Nomad accounts that may read this bounty's entries and pick winners, besides Nomad's team (its sponsor). */
  reviewers?: Address[];
};

/** A sponsor's bounty as it is kept before and after Nomad's approval. */
export type DraftStatus = "waiting" | "returned" | "approved" | "cancelled";
export type StoredBounty = Bounty & {
  status: DraftStatus;
  createdAt: number;
  updatedAt: number;
  /** Nomad's note when it sent the bounty back. */
  note?: string;
  /** The schedule was set by Nomad and the sponsor cannot change it. */
  scheduleLocked?: boolean;
};

/** A whitelisted sponsor, from the site's settings: its Nomad account, and optionally a schedule set in advance. */
export type SponsorSpec = { name: string; account: Address; opens?: string; days?: number; prize?: string };

/** How much of an entry can be checked: a run Nomad recorded, transactions on chain, or the work alone. */
export type Proof = "nomad" | "onchain" | "work";
export const PROOF_LABEL: Record<Proof, string> = { nomad: "Recorded by Nomad", onchain: "On chain", work: "Work only" };

export type Submission = {
  at: number;
  text: string;
  proof: Proof;
  /** The hosted run behind it. */
  record?: RunRecord;
  /** Transactions the outside agent's wallet made after entering, checked on chain. */
  txs?: Hex[];
};

export type Entry = {
  bounty: string;
  /** The Nomad account it entered from, which is also where a prize is paid. */
  owner: Address;
  agentName: string;
  /** A hosted agent's id, or an outside agent's linked wallet. */
  agentId?: string;
  wallet?: Address;
  enteredAt: number;
  /** Checks that failed so far, and the last reason. */
  tries: number;
  problem?: string;
  submission?: Submission;
};

/** One winner and its prize. */
export type Award = {
  winner: Address;
  pickedAt: number;
  /** The prize locked in Bull's arbiter escrow for the winner (lib/bounties/bull.ts), until the reviewer confirms. */
  escrow?: { id: string; tx: Hex; expiresAt: number };
  paidTx?: Hex;
  paidAt?: number;
  /** "bull" when the prize was released from Bull's escrow; otherwise it was sent from the treasury. */
  paidVia?: "bull";
};

export type BountyResult = {
  /** The winners picked so far, in the order they were picked. */
  awards: Award[];
};

export type BountyState = "upcoming" | "open" | "judging" | "decided" | "paid";

/** A hosted agent's check failures before its entry stops. */
export const MAX_TRIES = 3;
/** Entries one Nomad account may have in bounties that are still open. */
export const MAX_OPEN_ENTRIES = 3;
export const MIN_SUBMISSION_CHARS = 40;
export const MAX_SUBMISSION_CHARS = 6000;
export const MAX_PROOF_TXS = 5;

export const PRIZE_DECIMALS: Record<PrizeToken, number> = { USDG: 6, NOMAD: 18 };

export const closesAt = (b: Bounty) => Date.parse(b.closes);
export const opensAt = (b: Bounty) => Date.parse(b.opens);
export const placesOf = (b: Bounty) => Math.max(1, Math.floor(b.places ?? 1));

/** Where a bounty is, from its dates and its result. Funding is checked separately. */
export function bountyState(b: Bounty, result: BountyResult | null, now = Date.now()): BountyState {
  const awards = result?.awards ?? [];
  if (awards.length >= placesOf(b)) return awards.every((a) => a.paidTx) ? "paid" : "decided";
  if (now < opensAt(b)) return "upcoming";
  if (now < closesAt(b)) return "open";
  return "judging";
}

/** The status line a creator sees for one entry. */
export function entryStatus(e: Entry, title: string, state: BountyState, result: BountyResult | null): string {
  const award = result?.awards.find((a) => a.winner.toLowerCase() === e.owner.toLowerCase());
  if (award) return award.paidTx ? `Won ${title}, paid` : `Won ${title}`;
  if (state === "decided" || state === "paid") return `${title}: not chosen`;
  if (e.submission) return `${title}: submitted`;
  if (state !== "open") return `${title}: closed before it submitted`;
  if (e.tries >= MAX_TRIES) return `${title}: out of tries (${e.problem ?? "checks did not pass"})`;
  if (e.problem) return `${title}: last try did not pass (${e.problem}). It tries again next run`;
  return `Working on ${title}`;
}

/** Messages signed to enter, submit, link and review. Each names what it is for and when, so it cannot be reused. */
export const hostedEnterMessage = (bounty: string, agentId: string, at: number) => `Nomad bounty ${bounty}: enter agent ${agentId} at ${at}`;
export const outsideEnterMessage = (bounty: string, at: number) => `Nomad bounty ${bounty}: enter at ${at}`;
export const submitMessage = (bounty: string, text: string, txs: readonly string[], at: number) =>
  `Nomad bounty ${bounty}: submit ${keccak256(toHex(text))}${txs.length ? ` with ${txs.map((t) => t.toLowerCase()).join(",")}` : ""} at ${at}`;
export const linkMessage = (wallet: string, name: string, at: number) => `Nomad: link outside agent ${wallet.toLowerCase()} named ${name} at ${at}`;
export const reviewMessage = (action: string, at: number) => `Nomad bounty review: ${action} at ${at}`;
export const sponsorMessage = (action: string, at: number) => `Nomad bounty sponsor: ${action} at ${at}`;

/** The fields a sponsor sets, in a fixed order, so a signature names exactly what it saves. */
export type DraftFields = { title: string; brief: string; result: string; places: number; opens: string; days: number };
export const draftFingerprint = (f: DraftFields) => keccak256(toHex(JSON.stringify([f.title, f.brief, f.result, f.places, f.opens, f.days])));
export const noteFingerprint = (note: string) => keccak256(toHex(note));

/**
 * A sponsor's fields as both sides read them, before any checks: the browser signs these, and the server checks the
 * same. A schedule Nomad set in advance replaces whatever was sent.
 */
export function normalDraft(raw: unknown, locked: { opens: string; days: number } | null): DraftFields {
  const o = (raw ?? {}) as Record<string, unknown>;
  const text = (k: string) => (typeof o[k] === "string" ? (o[k] as string).replace(/\r\n/g, "\n").trim() : "");
  const t = Date.parse(String(o.opens ?? ""));
  return {
    title: text("title"),
    brief: text("brief"),
    result: text("result"),
    places: Number(o.places ?? SPONSOR_MIN_PLACES),
    opens: locked ? locked.opens : Number.isFinite(t) ? new Date(t).toISOString() : "",
    days: locked ? locked.days : Number(o.days)
  };
}

/**
 * How a sponsor's prize is split: the whole prize (from its settings) shared equally by the winners, each prize
 * rounded down to the cent, and half of what is paid out from each side.
 */
export function sponsorSplit(wholePrize: string, places: number) {
  const whole = BigInt(Math.round(Number(wholePrize) * 100)) * 10_000n;
  const each = (whole / BigInt(places) / 10_000n) * 10_000n;
  const total = each * BigInt(places);
  const sponsor = total / 2n;
  return { each, total, sponsor, nomad: total - sponsor };
}
/** USDG units (6 decimals) as a plain amount: 12500000n is "12.5". */
export const usdgText = (u: bigint) => {
  const frac = (u % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${u / 1_000_000n}.${frac}` : `${u / 1_000_000n}`;
};

/** Limits on what a sponsor can post. */
/** A sponsor's whole prize when its settings name none. */
export const SPONSOR_PRIZE = "200";
export const SPONSOR_MIN_PLACES = 5;
export const SPONSOR_MAX_DAYS = 30;
export const SPONSOR_MAX_PLACES = 50;
export const BOUNTY_DAYS = [3, 7, 10, 14, 30] as const;

/** Word shingles of a text, for spotting copies. */
function shingles(text: string, n = 5): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9$%.]+/g, " ").split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  if (!out.size && words.length) out.add(words.join(" "));
  return out;
}

/** How alike two texts are, from 0 to 1 (shared five-word runs over all of them). */
export function similarity(a: string, b: string): number {
  const x = shingles(a);
  const y = shingles(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const s of x) if (y.has(s)) both += 1;
  return both / (x.size + y.size - both);
}
export const COPY_SIMILARITY = 0.6;
