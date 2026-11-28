/**
 * Nomad's own bounties, and who on Nomad's team reviews them. A bounty goes up when it is added here and deployed, and
 * it shows as open only while the treasury holds its prize.
 *
 * Sponsors post their own bounties from their account page. Who may post is set in the site's BOUNTY_SPONSORS
 * setting, as JSON, one entry per sponsor; "opens", "days" and "maxPrize" are optional:
 *
 *   [{ "name": "Venin", "account": "0x...", "opens": "2026-11-30T15:00:00Z", "days": 10, "maxPrize": "500" }]
 *
 * "account" is the sponsor's Nomad account (the address on its account page). With "opens" and "days" set, every
 * bounty it posts has that schedule and it cannot change it. A sponsor's bounty shows only after a team reviewer
 * approves it and the sponsor's share has reached the treasury from that account.
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

/** The sign-in wallets (or Nomad accounts) that may see the review and pick winners. Prizes are paid from the treasury. */
export const REVIEWERS: Address[] = ["0x742e2cB0D250c22D71a1df00Cf9D2c40214544a4"];
