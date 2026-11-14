import { NextResponse } from "next/server";
import { roundStatus, tally, tallyToJson, type Holders, type Round } from "./core";
import { loadHolders, loadIndex, loadRound } from "./rounds";
import { storeFromEnv, type VoteStore } from "./store";

export const NO_STORE = { "cache-control": "no-store" };

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function getStore(): VoteStore | null {
  return storeFromEnv();
}

/** `?round=N`, or the latest round when absent. Returns null when there is no such round. */
export async function resolveRound(param: string | null): Promise<Round | null> {
  const id = param ? Number(param) : (await loadIndex()).latest;
  if (!Number.isInteger(id) || id < 1) return null;
  return loadRound(id);
}

/** What the vote page shows: the round as published plus its results (final, or live while open). */
export async function publicRound(round: Round, holders: Holders, store: VoteStore | null, now = new Date()) {
  const status = roundStatus(round, now);
  let results = null;
  if (round.result) {
    const r = round.result;
    results = { final: true, totals: r.totals, voters: r.voters, totalWeight: r.totalWeight, voterCount: r.voterCount, winner: r.winner };
  } else if (status !== "upcoming" && store) {
    const votes = await store.listVotes(round.id);
    results = { final: false, ...tallyToJson(tally(round, holders, votes)) };
  }
  return {
    id: round.id,
    title: round.title,
    opensAt: round.opensAt,
    closesAt: round.closesAt,
    status,
    token: round.token,
    snapshot: round.snapshot,
    options: round.options,
    roundIssue: round.roundIssue,
    results,
    now: now.toISOString()
  };
}

export { loadHolders, loadIndex, loadRound };
