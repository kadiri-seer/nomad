/**
 * Agent bounties on the server: where bounties and entries live (Redis), entering, handing work in with its checks,
 * linking outside agents, sponsors' own bounties, and the review. Bounties come from lib/bounties/list.ts and from
 * whitelisted sponsors (approved by Nomad's team); everything here is written against injected dependencies (chain
 * reads, signatures, Venin) so the tests run without a network.
 */
import { getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import { NOMAD, TREASURY, USDG } from "../accounts/chain";
import { BULL_AGREEMENTS, checkEscrowPlan, ESCROW_HOURS, type createdAgreement } from "../bounties/bull";
import type { AgentRecord, RunRecord } from "../agents/shared";
import {
  BOUNTY_DAYS,
  bountyState,
  closesAt,
  COPY_SIMILARITY,
  draftFingerprint,
  entryStatus,
  hostedEnterMessage,
  linkMessage,
  MAX_OPEN_ENTRIES,
  MAX_PROOF_TXS,
  MAX_SUBMISSION_CHARS,
  MAX_TRIES,
  MIN_SUBMISSION_CHARS,
  normalDraft,
  noteFingerprint,
  opensAt,
  outsideEnterMessage,
  placesOf,
  PRIZE_DECIMALS,
  reviewMessage,
  similarity,
  SPONSOR_MAX_DAYS,
  SPONSOR_MAX_PLACES,
  SPONSOR_MIN_PLACES,
  SPONSOR_PRIZE,
  sponsorSplit,
  usdgText,
  sponsorMessage,
  entrantMessage,
  githubRepo,
  handInFingerprint,
  walletProofMessage,
  type Check,
  type HandInFields,
  submitMessage,
  type Award,
  type Bounty,
  type BountyResult,
  type BountyState,
  type DraftFields,
  type Entry,
  type PrizeToken,
  type Proof,
  type SponsorSpec,
  type StoredBounty
} from "../bounties/shared";
import { hashToObject, type RedisLike } from "../redis";
import { stoaPaymentChecks, type StoaService } from "../bounties/proof";
import type { RepoResult } from "./repo-check";

export class BountyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const ENTRIES = (b: string) => `nomad:bounty:${b}:entries`;
const RESULT = (b: string) => `nomad:bounty:${b}:result`;
const AGENT_BOUNTIES = (id: string) => `nomad:agent:${id}:bounties`;
const LINK = (wallet: string) => `nomad:bounty-link:${wallet.toLowerCase()}`;
const DRAFTS = "nomad:bounty-drafts";
const LINKS_OF = (owner: string) => `nomad:bounty-links:${owner.toLowerCase()}`;

export function bountyStore(redis: RedisLike) {
  return {
    async entries(bounty: string): Promise<Entry[]> {
      return Object.values(hashToObject(await redis.cmd(["HGETALL", ENTRIES(bounty)])))
        .map((r) => JSON.parse(r) as Entry).sort((a, b) => a.enteredAt - b.enteredAt);
    },
    async entry(bounty: string, owner: Address): Promise<Entry | null> {
      const raw = await redis.cmd(["HGET", ENTRIES(bounty), owner.toLowerCase()]);
      return typeof raw === "string" ? (JSON.parse(raw) as Entry) : null;
    },
    /** A new entry; false when this account already has one in the bounty. */
    async create(e: Entry) {
      return Number(await redis.cmd(["HSETNX", ENTRIES(e.bounty), e.owner.toLowerCase(), JSON.stringify(e)])) === 1;
    },
    async put(e: Entry) {
      await redis.cmd(["HSET", ENTRIES(e.bounty), e.owner.toLowerCase(), JSON.stringify(e)]);
    },
    async result(bounty: string): Promise<BountyResult | null> {
      const raw = await redis.cmd(["GET", RESULT(bounty)]);
      return typeof raw === "string" ? (JSON.parse(raw) as BountyResult) : null;
    },
    async setResult(bounty: string, r: BountyResult) {
      await redis.cmd(["SET", RESULT(bounty), JSON.stringify(r)]);
    },
    async agentBounties(agentId: string): Promise<string[]> {
      return ((await redis.cmd(["SMEMBERS", AGENT_BOUNTIES(agentId)])) as string[] | null) ?? [];
    },
    async addAgentBounty(agentId: string, bounty: string) {
      await redis.cmd(["SADD", AGENT_BOUNTIES(agentId), bounty]);
    },
    async removeAgentBounty(agentId: string, bounty: string) {
      await redis.cmd(["SREM", AGENT_BOUNTIES(agentId), bounty]);
    },
    async link(wallet: Address): Promise<WalletLink | null> {
      const raw = await redis.cmd(["GET", LINK(wallet)]);
      return typeof raw === "string" ? JSON.parse(raw) : null;
    },
    async setLink(wallet: Address, v: WalletLink) {
      await redis.cmd(["SET", LINK(wallet), JSON.stringify(v)]);
      await redis.cmd(["SADD", LINKS_OF(v.owner), wallet.toLowerCase()]);
    },
    /** The wallets an account linked, newest last. */
    async linksOf(owner: Address): Promise<(WalletLink & { wallet: Address })[]> {
      const wallets = ((await redis.cmd(["SMEMBERS", LINKS_OF(owner)])) as string[] | null) ?? [];
      const out = [];
      for (const w of wallets) {
        const l = await this.link(getAddress(w));
        if (l && l.owner.toLowerCase() === owner.toLowerCase()) out.push({ ...l, wallet: getAddress(w) });
      }
      return out.sort((a, b) => a.at - b.at);
    },
    /** Sponsors' bounties, in every state. */
    async drafts(): Promise<StoredBounty[]> {
      return Object.values(hashToObject(await redis.cmd(["HGETALL", DRAFTS]))).map((r) => JSON.parse(r) as StoredBounty);
    },
    async draft(id: string): Promise<StoredBounty | null> {
      const raw = await redis.cmd(["HGET", DRAFTS, id]);
      return typeof raw === "string" ? (JSON.parse(raw) as StoredBounty) : null;
    },
    async putDraft(b: StoredBounty) {
      await redis.cmd(["HSET", DRAFTS, b.id, JSON.stringify(b)]);
    }
  };
}
export type BountyStore = ReturnType<typeof bountyStore>;
/** An outside agent's wallet, linked to a Nomad account. "proven" once the wallet itself signed for it. */
export type WalletLink = { owner: Address; name: string; at: number; proven?: boolean };

export type BountyDeps = {
  store: BountyStore;
  list: Bounty[];
  reviewers: Address[];
  /** Whitelisted sponsors (from the site's settings). */
  sponsors?: SponsorSpec[];
  now: () => number;
  /** What the treasury holds of a prize token, in its smallest unit. */
  treasuryBalance(token: PrizeToken): Promise<bigint>;
  /** A signed message (plain wallets and smart accounts alike). */
  verify(address: Address, message: string, signature: Hex): Promise<boolean>;
  /** The Nomad account a Google wallet owns. */
  mainAccountOf(signer: Address): Promise<Address>;
  agent(id: string): Promise<AgentRecord | null>;
  /** True when `tx` succeeded, was made by `wallet` (directly or as a smart account), and after `sinceMs`. */
  txBy(wallet: Address, tx: Hex, sinceMs: number): Promise<boolean>;
  /** True when `tx` moved at least `amount` of `token` to `to`, from the treasury or from `from`. */
  paid(token: PrizeToken, to: Address, amount: bigint, tx: Hex, from?: Address): Promise<boolean>;
  /**
   * Marks a transaction as spent for credits, so a sponsor's deposit can never also be counted as credit top-up.
   * False when it was already counted (as credits, or as another deposit).
   */
  claimTx?(tx: Hex): Promise<boolean>;
  /** Bull's plan for a prize escrow (bull_agreement_from_template), as Bull answered. */
  bullPlan(args: Record<string, unknown>): Promise<unknown>;
  /** The Bull agreement a successful transaction created, from its receipt. */
  escrowCreated(tx: Hex): Promise<ReturnType<typeof createdAgreement>>;
  /** A GitHub repo's checks (lib/server/repo-check.ts). */
  repoCheck?(url: string): Promise<RepoResult>;
  /** A transaction's receipt and its block's time, or null when there is none. */
  receiptOf?(tx: Hex): Promise<{ status: string; from: Address; logs: { address: Address; data: Hex; topics: Hex[] }[]; time: number } | null>;
  /** Stoa's listed agent services. */
  stoaServices?(): Promise<StoaService[]>;
  /** Venin's count of planted instructions in a text. */
  venin(path: string, text: string): Promise<number>;
  /** How many secrets (keys, seed phrases, tokens) a text contains. */
  secrets(text: string): number;
};

const SIGNATURE_MAX_AGE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const isHash = (s: unknown): s is Hex => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
const lc = (a: string) => a.toLowerCase();

/** One winner's prize, in the token's smallest unit. */
export const prizeUnits = (b: Bounty) => parseUnits(b.prize.amount, PRIZE_DECIMALS[b.prize.token]);
/** The whole prize: one prize for each place. */
export const totalUnits = (b: Bounty) => prizeUnits(b) * BigInt(placesOf(b));
const usdgUnits = (s: string) => parseUnits(s, 6);

/** The whitelisted sponsors in the site's settings (BOUNTY_SPONSORS, JSON). Anything malformed is left out. */
export function parseSponsors(raw: string | undefined): SponsorSpec[] {
  if (!raw?.trim()) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: SponsorSpec[] = [];
  for (const x of list) {
    const o = (x ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.replace(/[^\p{L}\p{N} ._&-]/gu, "").trim().slice(0, 40) : "";
    if (!name || typeof o.account !== "string" || !isAddress(o.account, { strict: false })) continue;
    const spec: SponsorSpec = { name, account: getAddress(o.account) };
    if (typeof o.opens === "string" && Number.isFinite(Date.parse(o.opens))) spec.opens = new Date(Date.parse(o.opens)).toISOString();
    const days = Number(o.days);
    if (Number.isInteger(days) && days >= 1 && days <= SPONSOR_MAX_DAYS) spec.days = days;
    if (typeof o.prize === "string" && /^\d{1,6}(\.\d{1,2})?$/.test(o.prize) && Number(o.prize) > 0) spec.prize = o.prize;
    if (o.noInjectionScan === true) spec.noInjectionScan = true;
    const h = (o.handIn ?? null) as Record<string, unknown> | null;
    if (h && typeof h === "object") {
      const handIn: SponsorSpec["handIn"] = {};
      if (h.repo === true) handIn.repo = true;
      if (h.result === true) handIn.result = true;
      if (h.payment === "stoa-gasless" || h.payment === "any") handIn.payment = h.payment;
      spec.handIn = handIn;
    }
    out.push(spec);
  }
  return out;
}

export function bounties(d: BountyDeps) {
  const sponsors = d.sponsors ?? [];
  const fresh = (at: unknown) => {
    const n = Number(at);
    if (!Number.isFinite(n) || Math.abs(d.now() - n) > SIGNATURE_MAX_AGE_MS) throw new BountyError(400, "The signature is too old. Sign again.");
    return n;
  };
  const sig = (s: unknown): Hex => {
    if (typeof s !== "string" || !/^0x[0-9a-fA-F]+$/.test(s)) throw new BountyError(400, "signature is missing.");
    return s as Hex;
  };
  const signerOf = (s: unknown) => {
    if (typeof s !== "string" || !isAddress(s, { strict: false })) throw new BountyError(400, "signer is not an address.");
    return getAddress(s);
  };

  /** Every bounty that can be seen: the ones in the code, and sponsors' bounties Nomad approved. */
  async function all(): Promise<Bounty[]> {
    const approved = (await d.store.drafts()).filter((b) => b.status === "approved");
    return [...d.list, ...approved.map((b) => withSpec(publicFields(b)))];
  }
  async function byId(id: string): Promise<Bounty> {
    const b = (await all()).find((x) => x.id === id);
    if (!b) throw new BountyError(404, "There is no bounty by that name.");
    return b;
  }
  /** A sponsor's current settings apply to its bounties already saved: the hand-in form and the scanner choice. */
  function withSpec(b: Bounty): Bounty {
    const spec = b.sponsor ? sponsors.find((s) => lc(s.account) === lc(b.sponsor!.account)) : null;
    if (!spec) return b;
    return { ...b, ...(spec.handIn && !b.handIn ? { handIn: spec.handIn } : {}), ...(spec.noInjectionScan ? { noInjectionScan: true } : {}) };
  }
  /** A stored bounty without what only Nomad and its sponsor need. */
  function publicFields(b: StoredBounty): Bounty {
    const { status: _s, createdAt: _c, updatedAt: _u, note: _n, scheduleLocked: _l, ...rest } = b;
    return rest;
  }
  /** A sponsor's share is in once its deposit was read on chain (a bounty without a sponsor needs none). */
  const sponsorFunded = (b: Bounty) => !b.sponsor || usdgUnits(b.sponsor.share) === 0n || !!b.deposit;

  /** Whether an award still needs money from the treasury: not paid, and not locked in a live escrow. */
  const owing = (a: Award) => !a.paidTx && !(a.escrow && a.escrow.expiresAt > d.now());

  /**
   * Bounties the treasury can pay: for each prize token, every unpaid prize counted against its balance, earliest
   * closing first. A bounty past that point does not show as open.
   */
  async function funded(list?: Bounty[]): Promise<Set<string>> {
    const out = new Set<string>();
    // A sponsor's bounty counts only once its share is in, so an unfunded one never holds back the others.
    const rows = await Promise.all((list ?? (await all())).filter((b) => sponsorFunded(b) && !b.testers).map(async (b) => ({ b, r: await d.store.result(b.id) })));
    const unpaid = rows
      .map(({ b, r }) => {
        const awards = r?.awards ?? [];
        const open = placesOf(b) - awards.length;
        const places = BigInt(Math.max(0, open) + awards.filter(owing).length);
        return { b, need: prizeUnits(b) * places };
      })
      .filter((x) => x.need > 0n)
      .sort((x, y) => closesAt(x.b) - closesAt(y.b));
    for (const token of ["USDG", "NOMAD"] as PrizeToken[]) {
      const these = unpaid.filter((x) => x.b.prize.token === token);
      if (!these.length) continue;
      let left = await d.treasuryBalance(token).catch(() => 0n);
      for (const { b, need } of these) {
        if (need > left) break;
        left -= need;
        out.add(b.id);
      }
    }
    for (const { b, r } of rows) if ((r?.awards ?? []).length >= placesOf(b) && (r?.awards ?? []).every((a) => !owing(a))) out.add(b.id);
    return out;
  }

  /** A bounty's state, or "hidden" while it is not funded (its sponsor's share included) and not yet decided. */
  async function stateOf(b: Bounty, fundedSet?: Set<string>): Promise<{ state: BountyState | "hidden"; result: BountyResult | null }> {
    const result = await d.store.result(b.id);
    const state = bountyState(b, result, d.now());
    if (state === "decided" || state === "paid") return { state, result };
    if (b.testers) return { state, result };
    const f = fundedSet ?? (await funded());
    return { state: f.has(b.id) && sponsorFunded(b) ? state : "hidden", result };
  }

  async function openBounty(id: string) {
    const b = await byId(id);
    const { state } = await stateOf(b);
    if (state !== "open") throw new BountyError(409, state === "upcoming" ? "This bounty has not opened yet." : "This bounty is not open.");
    return b;
  }

  async function openEntriesOf(owner: Address) {
    let n = 0;
    for (const b of await all()) {
      if (bountyState(b, null, d.now()) !== "open") continue;
      if (await d.store.entry(b.id, owner)) n += 1;
    }
    return n;
  }

  /** The accounts that review a bounty besides Nomad's team: its listed reviewers and its sponsor. */
  const bountyReviewers = (b: Bounty) => [...(b.reviewers ?? []), ...(b.sponsor ? [b.sponsor.account] : [])].map(lc);

  async function createEntry(b: Bounty, e: Entry) {
    if (b.testers && !b.testers.map(lc).includes(lc(e.owner))) throw new BountyError(404, "There is no bounty by that name.");
    if (bountyReviewers(b).includes(lc(e.owner))) throw new BountyError(403, "A bounty's sponsor and reviewers cannot enter it.");
    if ((await openEntriesOf(e.owner)) >= MAX_OPEN_ENTRIES) throw new BountyError(409, `An account can be in at most ${MAX_OPEN_ENTRIES} open bounties at a time.`);
    if (!(await d.store.create(e))) throw new BountyError(409, "Your account has already entered this bounty. Each account gets one entry.");
  }

  /** The checks every piece of work goes through. Returns the problem, or null when it passes. */
  async function problemWith(b: Bounty, owner: Address, text: string, services?: string[], txs: Hex[] = []): Promise<string | null> {
    if (text.length < MIN_SUBMISSION_CHARS) return "the work is too short";
    if (text.length > MAX_SUBMISSION_CHARS) return `the work is longer than ${MAX_SUBMISSION_CHARS} characters`;
    // Hashes of transactions read on chain as this entry's proof are not keys, whatever the words around them say.
    const scanned = txs.reduce((t, h) => t.split(h).join("[tx]").split(lc(h)).join("[tx]"), text);
    if (d.secrets(scanned) > 0) return "the work contains what looks like a key or secret";
    if (!b.noInjectionScan && (await d.venin(`bounties/${b.id}/submission.md`, text).catch(() => 0)) > 0) return "Venin found planted instructions in it";
    if (services && b.services?.length) {
      const used = new Set(services.map(lc));
      const missing = b.services.filter((s) => !used.has(lc(s)));
      if (missing.length) return `it did not use ${missing.join(" and ")}, which the bounty requires`;
    }
    for (const other of await d.store.entries(b.id)) {
      if (lc(other.owner) === lc(owner) || !other.submission) continue;
      if (similarity(text, other.submission.text) >= COPY_SIMILARITY) return "it is too close to another entry";
    }
    return null;
  }

  /** The form's fields, trimmed and bounded, before any checks. */
  function handInOf(raw: unknown): HandInFields {
    const o = (raw ?? {}) as Record<string, unknown>;
    const str = (k: string, max: number) => (typeof o[k] === "string" ? (o[k] as string).replace(/\r\n/g, "\n").trim().slice(0, max) : "");
    const f: HandInFields = {};
    const repo = str("repo", 300);
    const tx = str("tx", 80).toLowerCase();
    const result = str("result", 500);
    const note = str("note", 3000);
    if (repo) f.repo = repo.replace(/\/+$/, "");
    if (tx) f.tx = tx as Hex;
    if (result) f.result = result;
    if (note) f.note = note;
    return f;
  }

  async function record(e: Entry, problem: string | null, submission: Entry["submission"]) {
    if (problem) {
      e.tries += 1;
      e.problem = problem;
    } else {
      e.problem = undefined;
      e.submission = submission;
    }
    await d.store.put(e);
  }

  async function accountOf(signer: Address) {
    return getAddress(await d.mainAccountOf(signer).catch(() => signer));
  }
  /** Nomad's team: the listed reviewers, by sign-in wallet or Nomad account. */
  async function isTeam(signer: Address) {
    const set = new Set(d.reviewers.map(lc));
    if (set.has(lc(signer))) return true;
    return set.has(lc(await d.mainAccountOf(signer).catch(() => "0x")));
  }
  /** Whether this signer reviews this bounty: Nomad's team, or its sponsor or listed reviewers. */
  async function reviews(signer: Address, b: Bounty) {
    if (await isTeam(signer)) return true;
    const who = [lc(signer), lc(await accountOf(signer))];
    return bountyReviewers(b).some((r) => who.includes(r));
  }
  /** The whitelist entry for a signer: listed by its Nomad account, or by the wallet it signs in with. */
  const sponsorOf = (signer: Address, account: Address) => sponsors.find((s) => lc(s.account) === lc(account) || lc(s.account) === lc(signer)) ?? null;

  /** A sponsor's fields (already read with normalDraft), checked against the limits. */
  async function checkDraft(f: DraftFields, locked: boolean): Promise<DraftFields> {
    const len = (v: string, min: number, max: number, label: string) => {
      if (v.length < min || v.length > max) throw new BountyError(400, `${label} must be ${min} to ${max} characters.`);
    };
    len(f.title, 3, 80, "The title");
    len(f.brief, 20, 1200, "What to do");
    len(f.result, 10, 400, "What to hand in");
    if (!Number.isInteger(f.places) || f.places < SPONSOR_MIN_PLACES || f.places > SPONSOR_MAX_PLACES) throw new BountyError(400, `Winners must be ${SPONSOR_MIN_PLACES} to ${SPONSOR_MAX_PLACES}.`);
    if (!locked) {
      if (!f.opens) throw new BountyError(400, "Choose when it opens.");
      if (Date.parse(f.opens) < d.now()) throw new BountyError(400, "It must open in the future.");
      if (!Number.isInteger(f.days) || f.days < 1 || f.days > SPONSOR_MAX_DAYS) throw new BountyError(400, `It can run 1 to ${SPONSOR_MAX_DAYS} days.`);
    }
    for (const [k, v] of [["title", f.title], ["brief", f.brief], ["result", f.result]] as const) {
      const name = k === "brief" ? "task" : k;
      if (d.secrets(v) > 0) throw new BountyError(400, `The ${name} contains what looks like a key or secret.`);
      if ((await d.venin(`bounties/new/${k}.md`, v).catch(() => 0)) > 0) throw new BountyError(400, `Venin found planted instructions in the ${name}, so it was not saved.`);
    }
    return f;
  }

  /** A sponsor's preset schedule, from its settings, when it has one. */
  const presetOf = (spec: SponsorSpec) => (spec.opens && spec.days ? { opens: spec.opens, days: spec.days } : null);
  const slug = (title: string) =>
    `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "bounty"}-${Math.floor(d.now() % 1_000_000).toString(36)}`;

  /** What a sponsor sees of its own bounty. */
  const mine = async (b: StoredBounty) => {
    const result = await d.store.result(b.id);
    const state = b.status === "approved" ? bountyState(b, result, d.now()) : null;
    return { ...b, state, entries: (await d.store.entries(b.id)).length, awards: result?.awards.length ?? 0 };
  };

  function awardOf(result: BountyResult | null, winner: Address) {
    return result?.awards.find((a) => lc(a.winner) === lc(winner)) ?? null;
  }
  async function setAward(id: string, result: BountyResult, a: Award) {
    await d.store.setResult(id, { ...result, awards: result.awards.map((x) => (lc(x.winner) === lc(a.winner) ? a : x)) });
  }
  const addressOf = (v: unknown, what: string) => {
    if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new BountyError(400, `${what} is not an address.`);
    return getAddress(v);
  };

  return {
    funded,
    stateOf,
    isReviewer: isTeam,

    /** What anyone may see: open, upcoming, judging and decided bounties, never the entries. */
    async publicList() {
      const list = await all();
      const f = await funded(list);
      const out = [];
      for (const b of list) {
        if (b.testers) continue;
        const { state, result } = await stateOf(b, f);
        if (state === "hidden") continue;
        const { reviewers: _r, ...shown } = b;
        const entries = await d.store.entries(b.id);
        out.push({ ...shown, state, entries: entries.length, handedIn: entries.filter((e) => e.submission).length, winners: result?.awards.length ?? 0 });
      }
      return out;
    },

    /** One bounty; once decided, its winning work and the proof behind it. Other entries stay private. */
    async publicOne(id: string) {
      const b = await byId(id);
      const { state, result } = await stateOf(b);
      if (state === "hidden" || b.testers) throw new BountyError(404, "There is no bounty by that name.");
      const winners = [];
      for (const a of result?.awards ?? []) {
        const e = await d.store.entry(b.id, a.winner);
        if (!e?.submission) continue;
        winners.push({
          agentName: e.agentName,
          ...(e.agentId ? { agentId: e.agentId } : {}),
          ...(e.wallet ? { wallet: e.wallet } : {}),
          submission: e.submission,
          paidTx: a.paidTx ?? null,
          ...(a.paidVia ? { paidVia: a.paidVia } : {}),
          ...(a.escrow ? { escrow: { id: a.escrow.id, expiresAt: a.escrow.expiresAt } } : {})
        });
      }
      const { reviewers: _r, ...shown } = b;
      const entries = await d.store.entries(b.id);
      return { ...shown, state, entries: entries.length, handedIn: entries.filter((e) => e.submission).length, winners };
    },

    /** A hosted agent enters: signed by its creator's Google wallet. Its next runs get the brief. */
    async enterHosted(body: { bounty?: unknown; agentId?: unknown; at?: unknown; signature?: unknown }) {
      const b = await openBounty(String(body.bounty ?? ""));
      const id = String(body.agentId ?? "");
      if (!/^\d{1,30}$/.test(id)) throw new BountyError(400, "agentId is not valid.");
      const a = await d.agent(id);
      if (!a) throw new BountyError(404, "There is no agent by that id.");
      const at = fresh(body.at);
      if (!(await d.verify(a.signer, hostedEnterMessage(b.id, id, at), sig(body.signature)).catch(() => false))) throw new BountyError(403, "Only the agent's creator can enter it.");
      await createEntry(b, { bounty: b.id, owner: getAddress(a.owner), agentName: a.name, agentId: id, enteredAt: d.now(), tries: 0 });
      await d.store.addAgentBounty(id, b.id);
      return { ok: true, status: `Working on ${b.title}` };
    },

    /** An outside agent links its wallet to a Nomad account: signed by the account's Google wallet. */
    async link(body: { signer?: unknown; wallet?: unknown; name?: unknown; at?: unknown; signature?: unknown; walletSignature?: unknown }) {
      const signer = signerOf(body.signer);
      if (typeof body.wallet !== "string" || !isAddress(body.wallet, { strict: false })) throw new BountyError(400, "That is not a wallet address.");
      const name = String(body.name ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 40);
      if (!name) throw new BountyError(400, "Give the agent a name.");
      const at = fresh(body.at);
      const wallet = getAddress(body.wallet);
      if (!(await d.verify(signer, linkMessage(wallet, name, at), sig(body.signature)).catch(() => false))) throw new BountyError(403, "The signature does not match.");
      const owner = getAddress(await d.mainAccountOf(signer));
      if (lc(wallet) === lc(owner) || lc(wallet) === lc(signer)) throw new BountyError(400, "Link the agent's own wallet, not your account.");
      // The wallet's own signature, when given, proves it is the agent's: then it can enter and hand in from the
      // account page. Without it, the agent signs each step itself (the API on the bounty's page).
      let proven = false;
      if (body.walletSignature !== undefined) {
        proven = await d.verify(wallet, walletProofMessage(wallet, owner), sig(body.walletSignature)).catch(() => false);
        if (!proven) throw new BountyError(403, "That signature is not from this wallet. Sign the exact message shown, with the agent's wallet.");
      }
      const had = await d.store.link(wallet);
      if (had && lc(had.owner) !== lc(owner)) throw new BountyError(409, "That wallet is already linked to another account.");
      await d.store.setLink(wallet, { owner, name, at: d.now(), ...(proven || had?.proven ? { proven: true } : {}) });
      return { ok: true, wallet, name, proven: proven || !!had?.proven };
    },

    /** An outside agent enters: signed by its own linked wallet. */
    async enterOutside(body: { bounty?: unknown; wallet?: unknown; at?: unknown; signature?: unknown }) {
      const b = await openBounty(String(body.bounty ?? ""));
      if (typeof body.wallet !== "string" || !isAddress(body.wallet, { strict: false })) throw new BountyError(400, "wallet is not an address.");
      const wallet = getAddress(body.wallet);
      const link = await d.store.link(wallet);
      if (!link) throw new BountyError(403, "Link this wallet to your Nomad account first, from your account page.");
      const at = fresh(body.at);
      if (!(await d.verify(wallet, outsideEnterMessage(b.id, at), sig(body.signature)).catch(() => false))) throw new BountyError(403, "The signature is not from that wallet.");
      await createEntry(b, { bounty: b.id, owner: getAddress(link.owner), agentName: link.name, wallet, enteredAt: d.now(), tries: 0 });
      return { ok: true, status: `Entered ${b.title}. Submit the work before ${b.closes}.` };
    },

    /**
     * An entrant's steps on the account page, each signed by its sign-in wallet: see its linked wallets and entries,
     * enter with a proven wallet, and hand in the form, which Nomad checks before taking it.
     */
    async entrant(body: Record<string, unknown>) {
      const signer = signerOf(body.signer);
      const at = fresh(body.at);
      const id = typeof body.bounty === "string" ? body.bounty : "";
      const wallet = typeof body.wallet === "string" && isAddress(body.wallet, { strict: false }) ? getAddress(body.wallet) : null;
      const fields = handInOf(body.fields);
      const label =
        body.action === "mine" ? "mine" : body.action === "enter" && wallet ? `enter ${id} ${lc(wallet)}` : body.action === "handin" && wallet ? `handin ${id} ${lc(wallet)} ${handInFingerprint(fields)}` : null;
      if (!label) throw new BountyError(400, "Unknown step.");
      if (!(await d.verify(signer, entrantMessage(label, at), sig(body.signature)).catch(() => false))) throw new BountyError(403, "The signature does not match.");
      const account = getAddress(await d.mainAccountOf(signer));

      if (body.action === "mine") {
        const links = (await d.store.linksOf(account)).map((l) => ({ wallet: l.wallet, name: l.name, proven: !!l.proven }));
        const entries = [];
        for (const b of await all()) {
          const e = await d.store.entry(b.id, account);
          if (!e || !e.wallet) continue;
          const result = await d.store.result(b.id);
          const state = bountyState(b, result, d.now());
          entries.push({
            bounty: b.id,
            title: b.title,
            closes: b.closes,
            state,
            wallet: e.wallet,
            agentName: e.agentName,
            status: entryStatus(e, b.title, state, result),
            handIn: b.handIn ?? {},
            triesLeft: Math.max(0, MAX_TRIES - e.tries),
            proven: !!links.find((l) => lc(l.wallet) === lc(e.wallet!))?.proven,
            ...(e.problem ? { problem: e.problem } : {}),
            ...(e.checks ? { checks: e.checks } : {}),
            ...(e.submission ? { submitted: { at: e.submission.at, fields: e.submission.fields ?? null, checks: e.submission.checks ?? [] } } : {})
          });
        }
        return { links, entries };
      }

      const link = await d.store.link(wallet!);
      if (!link || lc(link.owner) !== lc(account)) throw new BountyError(403, "Link this wallet to your account first.");
      if (!link.proven) throw new BountyError(403, "Prove this wallet is your agent's first: sign the link message with it.");

      if (body.action === "enter") {
        const b = await openBounty(id);
        await createEntry(b, { bounty: b.id, owner: account, agentName: link.name, wallet: wallet!, enteredAt: d.now(), tries: 0 });
        return { ok: true, status: `Entered ${b.title}` };
      }

      // handin
      const b = await openBounty(id);
      const e = await d.store.entry(b.id, account);
      if (!e || !e.wallet || lc(e.wallet) !== lc(wallet!)) throw new BountyError(409, "Enter this bounty with that wallet first.");
      if (e.submission) throw new BountyError(409, "This entry has already been handed in.");
      if (e.tries >= MAX_TRIES) throw new BountyError(409, "This entry is out of tries.");
      const spec = b.handIn ?? {};
      if (spec.repo && !fields.repo) throw new BountyError(400, "Add the link to your repo.");
      if (spec.payment && !fields.tx) throw new BountyError(400, "Add the hash of your payment transaction.");
      if (spec.result && !fields.result) throw new BountyError(400, "Add a link to the result: a note or a screen recording.");
      if (fields.tx && !isHash(fields.tx)) throw new BountyError(400, "That is not a transaction hash.");
      if (fields.result && !/^https:\/\/[^\s]{4,500}$/.test(fields.result)) throw new BountyError(400, "The result link must start with https://.");
      if (!fields.repo && !fields.tx && !fields.result && (fields.note ?? "").length < MIN_SUBMISSION_CHARS) throw new BountyError(400, `Write at least ${MIN_SUBMISSION_CHARS} characters about your work.`);

      const checks: Check[] = [];
      if (fields.tx) {
        const usedElsewhere = (await d.store.entries(b.id)).some((x) => lc(x.owner) !== lc(account) && (x.submission?.txs ?? []).some((t) => lc(t) === lc(fields.tx!)));
        if (usedElsewhere) checks.push({ name: "Payment", ok: false, detail: "That transaction is already part of another entry." });
        else if (spec.payment === "stoa-gasless") {
          if (!d.receiptOf || !d.stoaServices) throw new BountyError(503, "Payments cannot be checked on this site yet.");
          let receipt;
          let services;
          try {
            [receipt, services] = await Promise.all([d.receiptOf(fields.tx), d.stoaServices()]);
          } catch {
            throw new BountyError(503, "Could not read the chain or Stoa's services right now. Try again in a minute. This did not use a try.");
          }
          if (!receipt) checks.push({ name: "Paid a Stoa agent service", ok: false, detail: "That transaction was not found on Robinhood Chain. If it was just sent, wait a moment." });
          else checks.push(...stoaPaymentChecks(receipt, e.wallet, USDG, services, opensAt(b)));
        } else {
          const ok = await d.txBy(e.wallet, fields.tx, e.enteredAt).catch(() => null);
          if (ok === null) throw new BountyError(503, "Could not read the chain right now. Try again in a minute. This did not use a try.");
          checks.push(ok ? { name: "Made by your wallet", ok: true } : { name: "Made by your wallet", ok: false, detail: "That transaction was not made by your linked wallet after it entered." });
        }
      }
      if (fields.repo) {
        if (!githubRepo(fields.repo)) checks.push({ name: "Public GitHub repo", ok: false, detail: "Give the link to a GitHub repo, like https://github.com/you/your-repo." });
        else {
          if (!d.repoCheck) throw new BountyError(503, "Repos cannot be checked on this site yet.");
          const r = await d.repoCheck(fields.repo).catch(() => ({ unavailable: "GitHub did not answer" }));
          if ("unavailable" in r) throw new BountyError(503, `Could not check the repo right now (${r.unavailable}). Try again in a minute. This did not use a try.`);
          checks.push(...r.checks);
        }
      }
      if (fields.result) checks.push({ name: "Result link", ok: true });
      // The note and links themselves: no keys, no planted instructions (unless the bounty is about them), not a copy.
      const text = [fields.repo && `Repo: ${fields.repo}`, fields.tx && `Payment: ${fields.tx}`, fields.result && `Result: ${fields.result}`, fields.note].filter(Boolean).join("\n");
      const scanned = fields.tx ? text.split(fields.tx).join("[tx]") : text;
      if (d.secrets(scanned) > 0) checks.push({ name: "No secrets in the hand-in", ok: false, detail: "Your note or links contain what looks like a key or secret." });
      if (fields.note && !b.noInjectionScan && (await d.venin(`bounties/${b.id}/submission.md`, fields.note).catch(() => 0)) > 0) checks.push({ name: "No planted instructions", ok: false, detail: "Venin found planted instructions in your note." });
      if (fields.note && fields.note.length >= 200)
        for (const other of await d.store.entries(b.id)) {
          const theirs = other.submission?.fields?.note ?? (other.submission && !other.submission.fields ? other.submission.text : "");
          if (lc(other.owner) !== lc(account) && theirs && similarity(fields.note, theirs) >= COPY_SIMILARITY) {
            checks.push({ name: "Your own work", ok: false, detail: "Your note is too close to another entry." });
            break;
          }
        }

      const failed = checks.filter((c) => !c.ok);
      if (failed.length) {
        e.tries += 1;
        e.problem = failed[0].detail ?? failed[0].name;
        e.checks = checks;
        await d.store.put(e);
        return { ok: false, checks, triesLeft: Math.max(0, MAX_TRIES - e.tries) };
      }
      e.problem = undefined;
      e.checks = undefined;
      e.submission = { at: d.now(), text, proof: fields.tx ? "onchain" : "work", ...(fields.tx ? { txs: [fields.tx] } : {}), fields, checks };
      await d.store.put(e);
      return { ok: true, checks };
    },

    /** The bounties a hosted agent entered and has not handed in yet: the work for its next run. */
    async tasks(agent: AgentRecord) {
      const out = [];
      const list = await all();
      for (const id of await d.store.agentBounties(agent.id)) {
        const b = list.find((x) => x.id === id);
        const e = b ? await d.store.entry(b.id, agent.owner) : null;
        const state = b ? bountyState(b, await d.store.result(b.id), d.now()) : null;
        const done = !b || !e || e.agentId !== agent.id || !!e.submission || e.tries >= MAX_TRIES || state !== "open";
        if (done) {
          await d.store.removeAgentBounty(agent.id, id);
          continue;
        }
        out.push({ id: b!.id, title: b!.title, brief: b!.brief, result: b!.result, ...(b!.services ? { services: b!.services } : {}) });
      }
      return out;
    },

    /** A hosted run hands its work in, with the run's record as proof. */
    async submitHosted(agent: AgentRecord, bountyId: string, text: string, rec: RunRecord): Promise<{ ok: boolean; problem?: string }> {
      const b = await byId(bountyId);
      if (bountyState(b, await d.store.result(b.id), d.now()) !== "open") return { ok: false, problem: "the bounty has closed" };
      const e = await d.store.entry(b.id, agent.owner);
      if (!e || e.agentId !== agent.id || e.submission) return { ok: false, problem: "this agent has no open entry" };
      if (rec.startedAt < e.enteredAt) return { ok: false, problem: "the run started before the agent entered" };
      const used = [...new Set(rec.calls.filter((c) => c.ok).map((c) => c.service.replace(/ \(.*\)$/, "")))];
      const problem = await problemWith(b, e.owner, text, used);
      await record(e, problem, { at: d.now(), text, proof: "nomad", record: rec, ...(rec.txs.length ? { txs: rec.txs } : {}) });
      if (!problem || e.tries >= MAX_TRIES) await d.store.removeAgentBounty(agent.id, b.id);
      return problem ? { ok: false, problem } : { ok: true };
    },

    /** An outside agent hands its work in: signed by its wallet, with any transactions it made after entering. */
    async submitOutside(body: { bounty?: unknown; wallet?: unknown; text?: unknown; txs?: unknown; at?: unknown; signature?: unknown }) {
      const b = await openBounty(String(body.bounty ?? ""));
      if (bountyState(b, await d.store.result(b.id), d.now()) !== "open") throw new BountyError(409, "This bounty is not open.");
      if (typeof body.wallet !== "string" || !isAddress(body.wallet, { strict: false })) throw new BountyError(400, "wallet is not an address.");
      const wallet = getAddress(body.wallet);
      const link = await d.store.link(wallet);
      if (!link) throw new BountyError(403, "This wallet is not linked to a Nomad account.");
      const e = await d.store.entry(b.id, link.owner);
      if (!e || !e.wallet || lc(e.wallet) !== lc(wallet)) throw new BountyError(409, "This agent has not entered the bounty.");
      if (e.submission) throw new BountyError(409, "This entry has already been handed in.");
      if (e.tries >= MAX_TRIES) throw new BountyError(409, "This entry is out of tries.");
      const text = typeof body.text === "string" ? body.text.replace(/\r\n/g, "\n").trim() : "";
      const txs = Array.isArray(body.txs) ? body.txs : [];
      if (txs.length > MAX_PROOF_TXS || !txs.every(isHash)) throw new BountyError(400, `txs must be up to ${MAX_PROOF_TXS} transaction hashes.`);
      const at = fresh(body.at);
      if (!(await d.verify(wallet, submitMessage(b.id, text, txs, at), sig(body.signature)).catch(() => false))) throw new BountyError(403, "The signature is not from that wallet.");
      for (const tx of txs) if (!(await d.txBy(wallet, tx, e.enteredAt).catch(() => false))) throw new BountyError(400, `Transaction ${tx.slice(0, 10)}... was not made by this wallet after it entered.`);
      const proof: Proof = txs.length ? "onchain" : "work";
      if (b.proofRequired && proof === "work") throw new BountyError(400, "This bounty needs proof: include transactions your agent's wallet made after it entered.");
      const problem = await problemWith(b, e.owner, text, undefined, txs as Hex[]);
      await record(e, problem, { at: d.now(), text, proof, ...(txs.length ? { txs } : {}) });
      if (problem) throw new BountyError(422, `It did not pass a check: ${problem}. ${MAX_TRIES - e.tries} ${MAX_TRIES - e.tries === 1 ? "try" : "tries"} left.`);
      return { ok: true, proof };
    },

    /** The status line for each of an account's entries. */
    async statusOf(owner: Address) {
      const out = [];
      for (const b of await all()) {
        const e = await d.store.entry(b.id, owner);
        if (!e) continue;
        const result = await d.store.result(b.id);
        const state = bountyState(b, result, d.now());
        out.push({ bounty: b.id, title: b.title, ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.wallet ? { wallet: e.wallet } : {}), status: entryStatus(e, b.title, state, result) });
      }
      return out;
    },

    /**
     * Locking a picked winner's prize in Bull's escrow, from the treasury's own wallet (on a phone, inside the wallet's
     * browser, where there is no Nomad sign-in). Nothing here needs a signature: Bull's plan is checked field by field
     * and can only be sent by the treasury, and a lock is recorded only after Nomad reads on chain that the treasury
     * made it for that winner. The arbiter is always the first reviewer's Nomad account.
     */
    async lockList() {
      const out = [];
      for (const b of await all()) {
        if (b.testers) continue;
        const result = await d.store.result(b.id);
        for (const a of result?.awards ?? []) {
          if (a.paidTx) continue;
          const live = a.escrow && a.escrow.expiresAt > d.now() ? a.escrow : null;
          out.push({ id: b.id, title: b.title, prize: b.prize, winner: a.winner, ...(live ? { lockedUntil: live.expiresAt, agreement: live.id } : {}) });
        }
      }
      return { treasury: TREASURY, bounties: out };
    },

    async lockPlan(id: string, winnerRaw?: unknown) {
      const b = await byId(id);
      const result = await d.store.result(b.id);
      if (!result?.awards.length) throw new BountyError(409, "No winner is picked for this bounty yet.");
      const a = winnerRaw === undefined && result.awards.length === 1 ? result.awards[0] : awardOf(result, addressOf(winnerRaw, "winner"));
      if (!a) throw new BountyError(404, "That account is not a winner of this bounty.");
      if (a.paidTx) throw new BountyError(409, "This prize is already paid.");
      if (a.escrow && a.escrow.expiresAt > d.now()) throw new BountyError(409, "The prize is already locked with Bull.");
      const arbiter = d.reviewers[0];
      if (!arbiter) throw new BountyError(503, "No reviewer is set up to confirm the payment.");
      const token = b.prize.token === "USDG" ? USDG : NOMAD;
      const args = {
        template: "arbiter_escrow",
        chain: "robinhood",
        payer: TREASURY,
        payee: a.winner,
        arbiter,
        amount: b.prize.amount,
        asset: b.prize.token === "USDG" ? "usdg" : NOMAD,
        expiryHours: ESCROW_HOURS,
        terms: `Nomad agent bounty "${b.title}" (${b.id}): the prize for a winning entry, released when Nomad's reviewer confirms.`
      };
      let plan;
      try {
        plan = checkEscrowPlan(await d.bullPlan(args), { winner: a.winner, arbiter, token, amount: prizeUnits(b), nowSec: Math.floor(d.now() / 1000) });
      } catch (e) {
        throw new BountyError(502, `Bull's plan was not used: ${(e as Error).message}`);
      }
      return {
        treasury: TREASURY,
        winner: a.winner,
        arbiter,
        feeWei: plan.feeWei.toString(),
        feeUsd: plan.feeUsd,
        expiresAt: plan.expiresAt,
        calls: plan.calls.map((c) => ({ to: c.to, data: c.data, value: c.value.toString() }))
      };
    },

    async lockRecord(id: string, tx: unknown, winnerRaw?: unknown) {
      const b = await byId(id);
      if (!isHash(tx)) throw new BountyError(400, "tx is not a transaction hash.");
      const result = await d.store.result(b.id);
      if (!result?.awards.length) throw new BountyError(409, "No winner is picked for this bounty yet.");
      const a = winnerRaw === undefined && result.awards.length === 1 ? result.awards[0] : awardOf(result, addressOf(winnerRaw, "winner"));
      if (!a) throw new BountyError(404, "That account is not a winner of this bounty.");
      if (a.paidTx) throw new BountyError(409, "This prize is already paid.");
      if (a.escrow?.tx && lc(a.escrow.tx) === lc(tx)) return { ok: true, escrow: a.escrow.id };
      if (a.escrow && a.escrow.expiresAt > d.now()) throw new BountyError(409, "The prize is already locked with Bull.");
      const token = b.prize.token === "USDG" ? USDG : NOMAD;
      const made = await d.escrowCreated(tx).catch(() => null);
      if (!made || lc(made.payer) !== lc(TREASURY) || lc(made.payee) !== lc(a.winner) || lc(made.asset) !== lc(token) || made.amount < prizeUnits(b) || made.expiresAt <= d.now())
        throw new BountyError(400, `That transaction did not lock ${b.prize.amount} ${b.prize.token} from the treasury for the winner with Bull. If it was just sent, wait a moment and try again.`);
      // The same lock cannot stand for two winners.
      if (result.awards.some((x) => x !== a && x.escrow?.id === made.id)) throw new BountyError(409, "That lock is already recorded for another winner.");
      await setAward(b.id, result, { ...a, escrow: { id: made.id, tx, expiresAt: made.expiresAt } });
      return { ok: true, escrow: made.id };
    },

    /**
     * A sponsor's own bounties, each step signed by the sponsor's Google wallet; its Nomad account must be on the
     * whitelist. "check" tells a wallet only about itself.
     */
    async sponsor(body: Record<string, unknown>) {
      const signer = signerOf(body.signer);
      const at = fresh(body.at);
      const action = body.action;
      const id = typeof body.bounty === "string" ? body.bounty : "";
      let label: string;
      let fields: DraftFields | null = null;
      const account = await accountOf(signer);
      const spec = sponsorOf(signer, account);
      if (action === "check") label = "check";
      else if (action === "save") {
        if (!spec) throw new BountyError(403, "This account is not a bounty sponsor on Nomad.");
        const existing = id ? await d.store.draft(id) : null;
        const lockedSchedule = existing?.scheduleLocked ? { opens: existing.opens, days: Math.round((closesAt(existing) - opensAt(existing)) / DAY_MS) } : presetOf(spec);
        fields = normalDraft(body.draft, lockedSchedule);
        label = `save ${id || "new"} ${draftFingerprint(fields)}`;
      } else if (action === "cancel") label = `cancel ${id}`;
      else if (action === "deposit" && isHash(body.tx)) label = `deposit ${id} ${lc(body.tx)}`;
      else throw new BountyError(400, "Unknown sponsor step.");
      if (!(await d.verify(signer, sponsorMessage(label, at), sig(body.signature)).catch(() => false))) throw new BountyError(403, "The signature does not match.");

      if (action === "check") {
        if (!spec) return { sponsor: null };
        const list = (await d.store.drafts()).filter((b) => b.sponsor && lc(b.sponsor.account) === lc(spec.account) && b.status !== "cancelled");
        return { sponsor: { name: spec.name, account: spec.account, preset: presetOf(spec), prize: spec.prize ?? SPONSOR_PRIZE }, bounties: await Promise.all(list.map(mine)) };
      }
      if (!spec) throw new BountyError(403, "This account is not a bounty sponsor on Nomad.");

      if (action === "save") {
        const existingFirst = id ? await d.store.draft(id) : null;
        const f = await checkDraft(fields!, !!(existingFirst?.scheduleLocked || presetOf(spec)));
        const split = sponsorSplit(spec.prize ?? SPONSOR_PRIZE, f.places);
        const existing = id ? await d.store.draft(id) : null;
        if (id && (!existing || !existing.sponsor || lc(existing.sponsor.account) !== lc(spec.account))) throw new BountyError(404, "There is no bounty of yours by that name.");
        if (existing && (existing.status === "cancelled" || (existing.status === "approved" && d.now() >= opensAt(existing)))) throw new BountyError(409, "This bounty can no longer be changed.");
        if (existing?.deposit && f.places !== placesOf(existing)) throw new BountyError(409, "Your share is already deposited, so the number of winners stays as it is.");
        const b: StoredBounty = {
          id: existing?.id ?? slug(f.title),
          title: f.title,
          brief: f.brief,
          result: f.result,
          prize: existing?.deposit ? existing.prize : { amount: usdgText(split.each), token: "USDG" },
          opens: f.opens,
          closes: new Date(Date.parse(f.opens) + f.days * DAY_MS).toISOString(),
          places: f.places,
          // Half each: the sponsor's half from its Nomad account, Nomad's half from the treasury.
          sponsor: { name: spec.name, account: spec.account, share: existing?.deposit ? existing.sponsor!.share : usdgText(split.sponsor) },
          nomadShare: existing?.deposit ? existing.nomadShare : usdgText(split.nomad),
          ...(spec.noInjectionScan ? { noInjectionScan: true } : {}),
          ...(spec.handIn ? { handIn: spec.handIn } : {}),
          // When the whitelist names the sponsor's wallet rather than its Nomad account, the account is kept too: it
          // reviews the bounty, cannot enter it, and can send the sponsor's half.
          ...(lc(account) !== lc(spec.account) ? { reviewers: [account] } : {}),
          // A change, even after approval, goes back to Nomad before it shows.
          status: "waiting",
          createdAt: existing?.createdAt ?? d.now(),
          updatedAt: d.now(),
          ...(existing?.scheduleLocked || presetOf(spec) ? { scheduleLocked: true } : {}),
          ...(existing?.deposit ? { deposit: existing.deposit } : {})
        };
        if (d.list.some((x) => x.id === b.id) || (!existing && (await d.store.draft(b.id)))) throw new BountyError(409, "Choose another title, or try again.");
        await d.store.putDraft(b);
        return { ok: true, bounty: await mine(b) };
      }

      const b = await d.store.draft(id);
      if (!b || !b.sponsor || lc(b.sponsor.account) !== lc(spec.account)) throw new BountyError(404, "There is no bounty of yours by that name.");
      if (action === "cancel") {
        if (b.status === "approved" && d.now() >= opensAt(b)) throw new BountyError(409, "This bounty has opened, so it cannot be cancelled here. Ask Nomad.");
        await d.store.putDraft({ ...b, status: "cancelled", updatedAt: d.now() });
        return { ok: true, refund: b.deposit ? `Nomad sends your ${b.deposit.amount} USDG back from the treasury.` : null };
      }
      // deposit
      if (b.status !== "approved") throw new BountyError(409, "Fund your share once Nomad has approved the bounty.");
      if (b.deposit) return { ok: true, deposit: b.deposit };
      const share = usdgUnits(b.sponsor.share);
      if (share === 0n) throw new BountyError(409, "This bounty has no share for you to fund.");
      const tx = body.tx as Hex;
      // From the sponsor's Nomad account (the usual way), or from the wallet the whitelist names.
      let sent = false;
      for (const from of new Set([lc(b.sponsor.account), ...(b.reviewers ?? []).map(lc)]))
        if (!sent) sent = await d.paid("USDG", TREASURY, share, tx, getAddress(from)).catch(() => false);
      if (!sent) throw new BountyError(400, `That transaction did not send ${b.sponsor.share} USDG from your Nomad account to the treasury. If it was just sent, wait a moment and try again.`);
      if (d.claimTx && !(await d.claimTx(tx))) throw new BountyError(409, "That transaction was already counted, as credits or as another deposit.");
      const deposit = { tx, amount: b.sponsor.share, at: d.now() };
      await d.store.putDraft({ ...b, deposit, updatedAt: d.now() });
      return { ok: true, deposit };
    },

    /**
     * The review, each step signed by the reviewer's Google wallet. Nomad's team approves sponsors' bounties, sees
     * every bounty and records payments; a bounty's sponsor reads its entries and picks its winners after the close.
     */
    async review(body: Record<string, unknown>) {
      const signer = signerOf(body.signer);
      const at = fresh(body.at);
      const id = String(body.bounty ?? "");
      const winner = typeof body.winner === "string" && isAddress(body.winner, { strict: false }) ? lc(body.winner) : null;
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
      const opens = typeof body.opens === "string" ? body.opens : "";
      const days = Number(body.days);
      const locked = body.locked === true;
      const action =
        body.action === "check"
          ? "check"
          : body.action === "list"
            ? "list"
            : body.action === "pending"
              ? "pending"
              : body.action === "pick" && winner
                ? `pick ${id} ${winner}`
                : body.action === "unpick" && winner
                  ? `unpick ${id} ${winner}`
                  : body.action === "paid" && isHash(body.tx)
                      ? `paid ${id}${winner ? ` ${winner}` : ""} ${lc(body.tx)}`
                      : body.action === "approve"
                        ? `approve ${id} ${opens} ${days} ${locked ? 1 : 0}`
                        : body.action === "return"
                          ? `return ${id} ${noteFingerprint(note)}`
                          : null;
      if (!action) throw new BountyError(400, "Unknown review step.");
      if (!(await d.verify(signer, reviewMessage(action, at), sig(body.signature)).catch(() => false))) throw new BountyError(403, "The signature does not match.");
      const team = await isTeam(signer);
      // Bull's escrow names one arbiter, the first reviewer's Nomad account: only it can confirm and release a prize.
      const first = d.reviewers[0] ? lc(d.reviewers[0]) : "";
      const arbiter = !!first && (lc(signer) === first || lc(await accountOf(signer)) === first);
      const list = await all();
      // Whether a wallet reviews is told only to that wallet, so nobody can look up who the reviewers are.
      if (body.action === "check") {
        const some = team || (await Promise.all(list.map((b) => reviews(signer, b)))).some(Boolean);
        return { reviewer: some, team };
      }

      if (body.action === "pending" || body.action === "approve" || body.action === "return") {
        if (!team) throw new BountyError(403, "Only the Nomad team approves bounties.");
        if (body.action === "pending") {
          const drafts = await d.store.drafts();
          const f = await funded(list);
          // Approved sponsors' bounties until they are paid: where each stands, and whether it shows on the site yet.
          const approved = [];
          for (const b of drafts.filter((x) => x.status === "approved").sort((x, y) => opensAt(x) - opensAt(y))) {
            const result = await d.store.result(b.id);
            const state = bountyState(b, result, d.now());
            if (state === "paid") continue;
            const halfIn = sponsorFunded(b);
            approved.push({ ...b, state, entries: (await d.store.entries(b.id)).length, halfIn, showing: halfIn && f.has(b.id), wholePrize: usdgText(totalUnits(b)) });
          }
          return { bounties: drafts.filter((b) => b.status === "waiting").sort((a, b) => a.updatedAt - b.updatedAt), approved };
        }
        const b = await d.store.draft(id);
        if (!b || b.status !== "waiting") throw new BountyError(409, "That bounty is not waiting for approval.");
        if (body.action === "return") {
          if (!note) throw new BountyError(400, "Say what to change.");
          await d.store.putDraft({ ...b, status: "returned", note, updatedAt: d.now() });
          return { ok: true };
        }
        // approve, with the schedule kept or set here
        if (usdgUnits(b.nomadShare ?? "0") + usdgUnits(b.sponsor?.share ?? "0") !== totalUnits(b)) throw new BountyError(409, "The two halves do not add up to the whole prize. Ask the sponsor to save it again.");
        const t = Date.parse(opens);
        if (!Number.isFinite(t) || !Number.isInteger(days) || days < 1 || days > SPONSOR_MAX_DAYS) throw new BountyError(400, `Set when it opens and how many days it runs (1 to ${SPONSOR_MAX_DAYS}).`);
        if (t + days * DAY_MS <= d.now()) throw new BountyError(400, "That schedule has already ended.");
        await d.store.putDraft({
          ...b,
          status: "approved",
          opens: new Date(t).toISOString(),
          closes: new Date(t + days * DAY_MS).toISOString(),
          ...(locked || b.scheduleLocked ? { scheduleLocked: true } : {}),
          note: undefined,
          updatedAt: d.now()
        });
        return { ok: true };
      }

      if (body.action === "list") {
        const out = [];
        const theirs = [];
        for (const b of list) if (!b.testers && (await reviews(signer, b))) theirs.push(b);
        if (!team && !theirs.length) throw new BountyError(403, "Only the Nomad team and a bounty's sponsor can review it.");
        for (const b of theirs) {
          const result = await d.store.result(b.id);
          const state = bountyState(b, result, d.now());
          // Winners are picked at the end: only closed bounties that are not paid yet.
          if (state === "upcoming" || state === "open" || state === "paid") continue;
          const entries = (await d.store.entries(b.id)).filter((e) => e.submission);
          out.push({ ...b, state, result, prizeUnits: prizeUnits(b).toString(), entries, team, arbiter });
        }
        return { bounties: out };
      }

      const b = await byId(id);
      if (!(await reviews(signer, b))) throw new BountyError(403, "Only the Nomad team and this bounty's sponsor can review it.");
      const result: BountyResult = (await d.store.result(b.id)) ?? { awards: [] };

      if (body.action === "pick") {
        const state = bountyState(b, result, d.now());
        if (state === "upcoming") throw new BountyError(409, "This bounty has not opened yet.");
        if (state === "open") throw new BountyError(409, "Pick the winner after the bounty closes.");
        if (result.awards.length >= placesOf(b)) throw new BountyError(409, placesOf(b) === 1 ? "The winner is already picked." : "Every place is already picked.");
        if (awardOf(result, winner as Address)) throw new BountyError(409, "That account is already a winner here.");
        const e = await d.store.entry(b.id, getAddress(winner!));
        if (!e?.submission) throw new BountyError(404, "That account has no handed-in entry here.");
        await d.store.setResult(b.id, { ...result, awards: [...result.awards, { winner: getAddress(winner!), pickedAt: d.now() }] });
        return { ok: true, places: placesOf(b), picked: result.awards.length + 1 };
      }
      if (body.action === "unpick") {
        const a = awardOf(result, winner as Address);
        if (!a) throw new BountyError(404, "That account is not a winner here.");
        if (a.paidTx || (a.escrow && a.escrow.expiresAt > d.now())) throw new BountyError(409, "That prize is locked or paid, so the pick stays.");
        await d.store.setResult(b.id, { ...result, awards: result.awards.filter((x) => x !== a) });
        return { ok: true };
      }
      // paid: only Nomad's team records payments.
      if (!team) throw new BountyError(403, "Only the Nomad team records payments.");
      if (!result.awards.length) throw new BountyError(409, "Pick a winner first.");
      const a = winner ? awardOf(result, winner as Address) : result.awards.length === 1 ? result.awards[0] : null;
      if (!a) throw new BountyError(404, winner ? "That account is not a winner here." : "Say which winner this payment is for.");
      if (a.paidTx) throw new BountyError(409, "This prize is already paid.");
      const tx = body.tx as Hex;
      if (result.awards.some((x) => x.paidTx && lc(x.paidTx) === lc(tx))) throw new BountyError(409, "That payment is already recorded for another winner.");
      // Paid: released from Bull's escrow (the usual way), or sent straight from the treasury.
      const from = a.escrow ? BULL_AGREEMENTS : undefined;
      if (!(await d.paid(b.prize.token, a.winner, prizeUnits(b), tx, from).catch(() => false)))
        throw new BountyError(
          400,
          a.escrow
            ? `That transaction did not release ${b.prize.amount} ${b.prize.token} from Bull's escrow to the winner's account. If it was just sent, wait a moment and try again.`
            : `That transaction did not send ${b.prize.amount} ${b.prize.token} from the treasury to the winner's account. If it was just sent, wait a moment and try again.`
        );
      await setAward(b.id, result, { ...a, paidTx: tx, paidAt: d.now(), ...(a.escrow ? { paidVia: "bull" as const } : {}) });
      return { ok: true };
    }
  };
}
export type Bounties = ReturnType<typeof bounties>;

export { BOUNTY_DAYS };
