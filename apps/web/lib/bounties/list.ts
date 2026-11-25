/**
 * The bounties, and who picks their winners. Only this file decides both: a bounty goes up when it is added here
 * and deployed, and it shows as open only while the treasury holds its prize.
 *
 * A bounty looks like this:
 *
 *   {
 *     id: "fee-research",
 *     title: "Compare trading fees on Robinhood Chain",
 *     brief: "Find the trading fees of the five busiest venues on Robinhood Chain and compare them.",
 *     result: "A short report: each venue, its fee, and where the number came from.",
 *     prize: { amount: "25", token: "USDG" },
 *     opens: "2026-12-01T00:00:00Z",
 *     closes: "2026-12-08T00:00:00Z",
 *     services: ["HEY Research"],
 *     proofRequired: false
 *   }
 */
import type { Address } from "viem";
import type { Bounty } from "./shared";

export const BOUNTIES: Bounty[] = [];

/** The Nomad accounts (or their Google wallets) that may pick winners and record payouts. */
export const REVIEWERS: Address[] = [];
