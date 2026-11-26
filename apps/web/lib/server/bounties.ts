/**
 * Agent bounties on the server: where entries live (Redis), entering, handing work in with its checks, linking outside
 * agents, and the team's review. The list of bounties and reviewers is lib/bounties/list.ts; everything here is
 * written against injected dependencies (chain reads, signatures, Venin) so the tests run without a network.
 */
import { getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import { NOMAD, TREASURY, USDG } from "../accounts/chain";
import { BULL_AGREEMENTS, checkEscrowPlan, ESCROW_HOURS, type createdAgreement } from "../bounties/bull";
import type { AgentRecord, RunRecord } from "../agents/shared";
import {
  bountyState,
  closesAt,
  COPY_SIMILARITY,
  entryStatus,
  hostedEnterMessage,
  linkMessage,
  MAX_OPEN_ENTRIES,
  MAX_PROOF_TXS,
  MAX_SUBMISSION_CHARS,
  MAX_TRIES,
  MIN_SUBMISSION_CHARS,
  outsideEnterMessage,
  PRIZE_DECIMALS,
  reviewMessage,
  similarity,
  submitMessage,
  type Bounty,
  type BountyResult,
  type BountyState,
  type Entry,
  type PrizeToken,
  type Proof
} from "../bounties/shared";
import { hashToObject, type RedisLike } from "../redis";

export class BountyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const ENTRIES = (b: string) => `nomad:bounty:${b}:entries`;
const RESULT = (b: string) => `nomad:bounty:${b}:result`;
const AGENT_BOUNTIES = (id: string) => `nomad:agent:${id}:bounties`;
const LINK = (wallet: string) => `nomad:bounty-link:${wallet.toLowerCase()}`;

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
    async link(wallet: Address): Promise<{ owner: Address; name: string; at: number } | null> {
      const raw = await redis.cmd(["GET", LINK(wallet)]);
      return typeof raw === "string" ? JSON.parse(raw) : null;
    },
    async setLink(wallet: Address, v: { owner: Address; name: string; at: number }) {
      await redis.cmd(["SET", LINK(wallet), JSON.stringify(v)]);
    }
  };
}
export type BountyStore = ReturnType<typeof bountyStore>;

export type BountyDeps = {
  store: BountyStore;
  list: Bounty[];
  reviewers: Address[];
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
  /** True when `tx` moved at least `amount` of `token` to `to`, from the treasury or (`from`) Bull's agreements contract. */
  paid(token: PrizeToken, to: Address, amount: bigint, tx: Hex, from?: Address): Promise<boolean>;
  /** Bull's plan for a prize escrow (bull_agreement_from_template), as Bull answered. */
  bullPlan(args: Record<string, unknown>): Promise<unknown>;
  /** The Bull agreement a successful transaction created, from its receipt. */
  escrowCreated(tx: Hex): Promise<ReturnType<typeof createdAgreement>>;
  /** Venin's count of planted instructions in a text. */
  venin(path: string, text: string): Promise<number>;
  /** How many secrets (keys, seed phrases, tokens) a text contains. */
  secrets(text: string): number;
};

const SIGNATURE_MAX_AGE_MS = 10 * 60_000;
const isHash = (s: unknown): s is Hex => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
const lc = (a: string) => a.toLowerCase();

export const prizeUnits = (b: Bounty) => parseUnits(b.prize.amount, PRIZE_DECIMALS[b.prize.token]);

export function bounties(d: BountyDeps) {
  const byId = (id: string) => {
    const b = d.list.find((x) => x.id === id);
    if (!b) throw new BountyError(404, "There is no bounty by that name.");
    return b;
  };
  const fresh = (at: unknown) => {
    const n = Number(at);
    if (!Number.isFinite(n) || Math.abs(d.now() - n) > SIGNATURE_MAX_AGE_MS) throw new BountyError(400, "The signature is too old. Sign again.");
    return n;
  };
  const sig = (s: unknown): Hex => {
    if (typeof s !== "string" || !/^0x[0-9a-fA-F]+$/.test(s)) throw new BountyError(400, "signature is missing.");
    return s as Hex;
  };

  /**
   * Bounties the treasury can pay: for each prize token, every unpaid prize counted against its balance, earliest
   * closing first. A bounty past that point does not show as open.
   */
  async function funded(): Promise<Set<string>> {
    const out = new Set<string>();
    const unpaid = (await Promise.all(d.list.map(async (b) => ({ b, r: await d.store.result(b.id) })))).filter((x) => !x.r?.paidTx && !(x.r?.escrow && x.r.escrow.expiresAt > d.now())).sort((x, y) => closesAt(x.b) - closesAt(y.b));
    for (const token of ["USDG", "NOMAD"] as PrizeToken[]) {
      const these = unpaid.filter((x) => x.b.prize.token === token);
      if (!these.length) continue;
      let left = await d.treasuryBalance(token).catch(() => 0n);
      for (const { b } of these) {
        const p = prizeUnits(b);
        if (p > left) break;
        left -= p;
        out.add(b.id);
      }
    }
    return out;
  }

  /** A bounty's state, or "hidden" while it is not funded and not yet decided. */
  async function stateOf(b: Bounty, fundedSet?: Set<string>): Promise<{ state: BountyState | "hidden"; result: BountyResult | null }> {
    const result = await d.store.result(b.id);
    const state = bountyState(b, result, d.now());
    if (state === "decided" || state === "paid") return { state, result };
    const f = fundedSet ?? (await funded());
    return { state: f.has(b.id) ? state : "hidden", result };
  }

  async function openBounty(id: string) {
    const b = byId(id);
    const { state } = await stateOf(b);
    if (state !== "open") throw new BountyError(409, state === "upcoming" ? "This bounty has not opened yet." : "This bounty is not open.");
    return b;
  }

  async function openEntriesOf(owner: Address) {
    let n = 0;
    for (const b of d.list) {
      if (bountyState(b, null, d.now()) !== "open") continue;
      if (await d.store.entry(b.id, owner)) n += 1;
    }
    return n;
  }

  async function createEntry(e: Entry) {
    if ((await openEntriesOf(e.owner)) >= MAX_OPEN_ENTRIES) throw new BountyError(409, `An account can be in at most ${MAX_OPEN_ENTRIES} open bounties at a time.`);
    if (!(await d.store.create(e))) throw new BountyError(409, "Your account has already entered this bounty. Each account gets one entry.");
  }

  /** The checks every piece of work goes through. Returns the problem, or null when it passes. */
  async function problemWith(b: Bounty, owner: Address, text: string, services?: string[]): Promise<string | null> {
    if (text.length < MIN_SUBMISSION_CHARS) return "the work is too short";
    if (text.length > MAX_SUBMISSION_CHARS) return `the work is longer than ${MAX_SUBMISSION_CHARS} characters`;
    if (d.secrets(text) > 0) return "the work contains what looks like a key or secret";
    if ((await d.venin(`bounties/${b.id}/submission.md`, text).catch(() => 0)) > 0) return "Venin found planted instructions in it";
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

  async function isReviewer(signer: Address) {
    const set = new Set(d.reviewers.map(lc));
    if (set.has(lc(signer))) return true;
    return set.has(lc(await d.mainAccountOf(signer).catch(() => "0x")));
  }

  return {
    funded,
    stateOf,
    isReviewer,

    /** What anyone may see: open, upcoming, judging and decided bounties, never the entries. */
    async publicList() {
      const f = await funded();
      const out = [];
      for (const b of d.list) {
        const { state, result } = await stateOf(b, f);
        if (state === "hidden") continue;
        out.push({ ...b, state, entries: (await d.store.entries(b.id)).length, ...(result?.paidTx ? { paidTx: result.paidTx } : {}) });
      }
      return out;
    },

    /** One bounty; once decided, its winning work and the proof behind it. Other entries stay private. */
    async publicOne(id: string) {
      const b = byId(id);
      const { state, result } = await stateOf(b);
      if (state === "hidden") throw new BountyError(404, "There is no bounty by that name.");
      let winner = null;
      if (result) {
        const e = await d.store.entry(b.id, result.winner);
        if (e?.submission) winner = { agentName: e.agentName, ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.wallet ? { wallet: e.wallet } : {}), submission: e.submission, paidTx: result.paidTx ?? null, ...(result.paidVia ? { paidVia: result.paidVia } : {}), ...(result.escrow ? { escrow: { id: result.escrow.id, expiresAt: result.escrow.expiresAt } } : {}) };
      }
      return { ...b, state, entries: (await d.store.entries(b.id)).length, winner };
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
      await createEntry({ bounty: b.id, owner: getAddress(a.owner), agentName: a.name, agentId: id, enteredAt: d.now(), tries: 0 });
      await d.store.addAgentBounty(id, b.id);
      return { ok: true, status: `Working on ${b.title}` };
    },

    /** An outside agent links its wallet to a Nomad account: signed by the account's Google wallet. */
    async link(body: { signer?: unknown; wallet?: unknown; name?: unknown; at?: unknown; signature?: unknown }) {
      if (typeof body.signer !== "string" || !isAddress(body.signer, { strict: false })) throw new BountyError(400, "signer is not an address.");
      if (typeof body.wallet !== "string" || !isAddress(body.wallet, { strict: false })) throw new BountyError(400, "That is not a wallet address.");
      const name = String(body.name ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 40);
      if (!name) throw new BountyError(400, "Give the agent a name.");
      const at = fresh(body.at);
      const signer = getAddress(body.signer);
      const wallet = getAddress(body.wallet);
      if (!(await d.verify(signer, linkMessage(wallet, name, at), sig(body.signature)).catch(() => false))) throw new BountyError(403, "The signature does not match.");
      const owner = getAddress(await d.mainAccountOf(signer));
      if (lc(wallet) === lc(owner) || lc(wallet) === lc(signer)) throw new BountyError(400, "Link the agent's own wallet, not your account.");
      const had = await d.store.link(wallet);
      if (had && lc(had.owner) !== lc(owner)) throw new BountyError(409, "That wallet is already linked to another account.");
      await d.store.setLink(wallet, { owner, name, at: d.now() });
      return { ok: true, wallet, name };
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
      await createEntry({ bounty: b.id, owner: getAddress(link.owner), agentName: link.name, wallet, enteredAt: d.now(), tries: 0 });
      return { ok: true, status: `Entered ${b.title}. Submit the work before ${b.closes}.` };
    },

    /** The bounties a hosted agent entered and has not handed in yet: the work for its next run. */
    async tasks(agent: AgentRecord) {
      const out = [];
      for (const id of await d.store.agentBounties(agent.id)) {
        const b = d.list.find((x) => x.id === id);
        const e = b ? await d.store.entry(b.id, agent.owner) : null;
        const done = !b || !e || e.agentId !== agent.id || !!e.submission || e.tries >= MAX_TRIES || bountyState(b, null, d.now()) !== "open";
        if (done) {
          await d.store.removeAgentBounty(agent.id, id);
          continue;
        }
        out.push({ id: b.id, title: b.title, brief: b.brief, result: b.result, ...(b.services ? { services: b.services } : {}) });
      }
      return out;
    },

    /** A hosted run hands its work in, with the run's record as proof. */
    async submitHosted(agent: AgentRecord, bountyId: string, text: string, rec: RunRecord): Promise<{ ok: boolean; problem?: string }> {
      const b = byId(bountyId);
      if (bountyState(b, null, d.now()) !== "open") return { ok: false, problem: "the bounty has closed" };
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
      const problem = await problemWith(b, e.owner, text);
      await record(e, problem, { at: d.now(), text, proof, ...(txs.length ? { txs } : {}) });
      if (problem) throw new BountyError(422, `It did not pass a check: ${problem}. ${MAX_TRIES - e.tries} ${MAX_TRIES - e.tries === 1 ? "try" : "tries"} left.`);
      return { ok: true, proof };
    },

    /** The status line for each of an account's entries. */
    async statusOf(owner: Address) {
      const out = [];
      for (const b of d.list) {
        const e = await d.store.entry(b.id, owner);
        if (!e) continue;
        const result = await d.store.result(b.id);
        const state = bountyState(b, result, d.now());
        out.push({ bounty: b.id, title: b.title, ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.wallet ? { wallet: e.wallet } : {}), status: entryStatus(e, b.title, state, result) });
      }
      return out;
    },

    /**
     * The team's review, each step signed by a reviewer's Google wallet: list closed bounties with their handed-in
     * entries, pick a winner after the close date, and record the payout once its transaction is on chain.
     */
    async review(body: { signer?: unknown; action?: unknown; bounty?: unknown; winner?: unknown; tx?: unknown; at?: unknown; signature?: unknown }) {
      if (typeof body.signer !== "string" || !isAddress(body.signer, { strict: false })) throw new BountyError(400, "signer is not an address.");
      const signer = getAddress(body.signer);
      const at = fresh(body.at);
      const action =
        body.action === "check"
          ? "check"
          : body.action === "list"
            ? "list"
            : body.action === "pick" && typeof body.winner === "string" && isAddress(body.winner, { strict: false })
              ? `pick ${String(body.bounty)} ${lc(body.winner)}`
              : body.action === "escrow-plan"
                ? `escrow-plan ${String(body.bounty)}`
                : body.action === "escrow" && isHash(body.tx)
                  ? `escrow ${String(body.bounty)} ${lc(body.tx)}`
                  : body.action === "paid" && isHash(body.tx)
                    ? `paid ${String(body.bounty)} ${lc(body.tx)}`
                    : null;
      if (!action) throw new BountyError(400, "Unknown review step.");
      if (!(await d.verify(signer, reviewMessage(action, at), sig(body.signature)).catch(() => false))) throw new BountyError(403, "The signature does not match.");
      // Whether a wallet reviews is told only to that wallet, so nobody can look up who the reviewers are.
      if (body.action === "check") return { reviewer: await isReviewer(signer) };
      if (!(await isReviewer(signer))) throw new BountyError(403, "Only the Nomad team can review bounties.");

      if (body.action === "list") {
        const out = [];
        for (const b of d.list) {
          const result = await d.store.result(b.id);
          const state = bountyState(b, result, d.now());
          if (state === "upcoming" || state === "open" || state === "paid") continue;
          const entries = (await d.store.entries(b.id)).filter((e) => e.submission);
          out.push({ ...b, state, result, prizeUnits: prizeUnits(b).toString(), entries });
        }
        return { bounties: out };
      }
      const b = byId(String(body.bounty ?? ""));
      const result = await d.store.result(b.id);
      if (body.action === "pick") {
        if (d.now() < closesAt(b)) throw new BountyError(409, "Pick the winner after the bounty closes.");
        if (result?.paidTx) throw new BountyError(409, "This bounty is already paid.");
        if (result?.escrow && result.escrow.expiresAt > d.now()) throw new BountyError(409, "The prize is already locked for the winner picked before.");
        const winner = getAddress(body.winner as string);
        const e = await d.store.entry(b.id, winner);
        if (!e?.submission) throw new BountyError(404, "That account has no handed-in entry here.");
        await d.store.setResult(b.id, { winner, pickedAt: d.now() });
        return { ok: true };
      }
      if (!result) throw new BountyError(409, "Pick a winner first.");
      if (result.paidTx) throw new BountyError(409, "This bounty is already paid.");
      const token = b.prize.token === "USDG" ? USDG : NOMAD;
      const live = result.escrow && result.escrow.expiresAt > d.now() ? result.escrow : null;

      // The prize goes into Bull's arbiter escrow: Bull plans it, Nomad checks every field, the treasury's wallet sends it.
      if (body.action === "escrow-plan") {
        if (live) throw new BountyError(409, "The prize is already locked with Bull.");
        // The arbiter is the reviewer's Nomad account, which confirms from this page.
        const arbiter = getAddress(await d.mainAccountOf(signer));
        const args = {
          template: "arbiter_escrow",
          chain: "robinhood",
          payer: TREASURY,
          payee: result.winner,
          arbiter,
          amount: b.prize.amount,
          asset: b.prize.token === "USDG" ? "usdg" : NOMAD,
          expiryHours: ESCROW_HOURS,
          terms: `Nomad agent bounty "${b.title}" (${b.id}): the prize for the winning entry, released when Nomad's reviewer confirms.`
        };
        let plan;
        try {
          plan = checkEscrowPlan(await d.bullPlan(args), { winner: result.winner, arbiter, token, amount: prizeUnits(b), nowSec: Math.floor(d.now() / 1000) });
        } catch (e) {
          throw new BountyError(502, `Bull's plan was not used: ${(e as Error).message}`);
        }
        return {
          treasury: TREASURY,
          arbiter,
          feeWei: plan.feeWei.toString(),
          feeUsd: plan.feeUsd,
          expiresAt: plan.expiresAt,
          quoteExpiresAt: plan.quoteExpiresAt,
          calls: plan.calls.map((c) => ({ to: c.to, data: c.data, value: c.value.toString() }))
        };
      }
      const tx = body.tx as Hex;
      if (body.action === "escrow") {
        if (live) throw new BountyError(409, "The prize is already locked with Bull.");
        const a = await d.escrowCreated(tx).catch(() => null);
        if (!a || lc(a.payer) !== lc(TREASURY) || lc(a.payee) !== lc(result.winner) || lc(a.asset) !== lc(token) || a.amount < prizeUnits(b) || a.expiresAt <= d.now())
          throw new BountyError(400, `That transaction did not lock ${b.prize.amount} ${b.prize.token} from the treasury for the winner with Bull. If it was just sent, wait a moment and try again.`);
        await d.store.setResult(b.id, { ...result, escrow: { id: a.id, tx, expiresAt: a.expiresAt } });
        return { ok: true, escrow: a.id };
      }
      // Paid: released from Bull's escrow (the usual way), or sent straight from the treasury.
      const from = result.escrow ? BULL_AGREEMENTS : undefined;
      if (!(await d.paid(b.prize.token, result.winner, prizeUnits(b), tx, from).catch(() => false)))
        throw new BountyError(
          400,
          result.escrow
            ? `That transaction did not release ${b.prize.amount} ${b.prize.token} from Bull's escrow to the winner's account. If it was just sent, wait a moment and try again.`
            : `That transaction did not send ${b.prize.amount} ${b.prize.token} from the treasury to the winner's account. If it was just sent, wait a moment and try again.`
        );
      await d.store.setResult(b.id, { ...result, paidTx: tx, paidAt: d.now(), ...(result.escrow ? { paidVia: "bull" as const } : {}) });
      return { ok: true };
    }
  };
}
export type Bounties = ReturnType<typeof bounties>;
