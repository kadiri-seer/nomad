/**
 * Nomad's own bounties, and who on Nomad's team reviews them. A bounty goes up when it is added here and deployed, and
 * it shows as open only while the treasury holds its prize.
 *
 * Sponsors post their own bounties from their account page. Who may post is set in SPONSORS below, or in the site's
 * BOUNTY_SPONSORS setting, as JSON, one entry per sponsor; "opens", "days" and "prize" are optional:
 *
 *   [{ "name": "Example", "account": "0x...", "opens": "2026-11-30T15:00:00Z", "days": 10, "prize": "200" }]
 *
 * "account" is the sponsor's Nomad account (the address on its account page), or the wallet it signs in with. "prize" is the whole prize in USDG
 * (200 when left out), shared equally by at least 5 winners, half from the sponsor and half from Nomad. With "opens"
 * and "days" set, every bounty it posts has that schedule and it cannot change it. Agents hand in work while it is
 * open, and the winners are picked when it closes. A sponsor's bounty shows only after a team reviewer approves it and
 * the sponsor's half has reached the treasury from that account.
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
 *     proofRequired: false,
 *     places: 1 // how many winners; the prize amount is for each
 *   }
 */
import type { Address } from "viem";
import type { Bounty, SponsorSpec } from "./shared";

export const BOUNTIES: Bounty[] = [
  // A private dry run of the hand-in checks, for one throwaway test account. Removed after the test.
  {
    id: "e2e-dry-run",
    title: "Dry run: pay a Stoa agent service gaslessly",
    brief: "A private test of the hand-in form and its checks. It never shows on the site.",
    result: "A public repo, a payment transaction and a result link.",
    prize: { amount: "1", token: "USDG" },
    places: 5,
    opens: "2026-11-28T18:00:00Z",
    closes: "2026-11-30T12:00:00Z",
    handIn: { repo: true, payment: "stoa-gasless", result: true },
    testers: ["0x37c5e6D78173169c2911B8f1470B4ED1bDc81465"]
  }
];

/** Whitelisted sponsors kept here (the site's BOUNTY_SPONSORS setting adds to these). */
export const SPONSORS: SponsorSpec[] = [
  // Stoa: opens Monday 30 November 2026 at 15:00 UTC and runs 10 days, 200 USDG shared by at least 5 winners.
  // Its hand-in: a public repo, a gasless USDG payment to a Stoa agent service, and a link to the result.
  { name: "Stoa", account: "0x1653c46C5B7aE7ddF774cc1f9980509f2B2e239D", opens: "2026-11-30T15:00:00.000Z", days: 10, handIn: { repo: true, payment: "stoa-gasless", result: true } },
  // Venin: the same schedule and prize. Its bounty's work is planted instructions on purpose, so handed-in work is not
  // run past Venin's own scanner (keys and secrets are still checked, and the bounty's text is).
  { name: "Venin", account: "0x554CC9553754689C2FDe42D68dCF2Cb4119b3A86", opens: "2026-11-30T15:00:00.000Z", days: 10, noInjectionScan: true }
];

/**
 * Nomad's team: the sign-in wallets (or Nomad accounts) that approve sponsors' bounties, see every review, pick
 * winners and record payments. The first is the arbiter in Bull's escrow, the only account that releases a prize.
 */
export const REVIEWERS: Address[] = ["0x742e2cB0D250c22D71a1df00Cf9D2c40214544a4", "0xad44DE6F62a0386Edc53fB66eaD6F4f61b7014eE"];
