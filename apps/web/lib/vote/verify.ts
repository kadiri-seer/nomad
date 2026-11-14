/** Vote checks that need signature recovery. Server and round jobs only; the page never loads this. */
import { recoverMessageAddress } from "viem";
import { isAddress, isExcluded, normalizeAddress, roundStatus, SIGNATURE_RE, voteMessage, weightOf, type Holders, type Round, type Vote } from "./core";

export type VoteInput = { round: unknown; choice: unknown; address: unknown; signature: unknown };

export type CheckedVote = { ok: true; vote: Vote } | { ok: false; status: number; error: string };

/** Checks everything about a vote except "has this wallet voted already", which the store decides. */
export async function checkVote(round: Round, holders: Holders, input: VoteInput, now = new Date()): Promise<CheckedVote> {
  if (input.round !== round.id) return { ok: false, status: 400, error: "This vote is for a different round." };
  const status = roundStatus(round, now);
  if (status === "upcoming") return { ok: false, status: 409, error: "This round has not opened yet." };
  if (status === "closed") return { ok: false, status: 409, error: "This round has closed." };
  if (!isAddress(input.address)) return { ok: false, status: 400, error: "That is not a wallet address." };
  if (typeof input.signature !== "string" || !SIGNATURE_RE.test(input.signature)) return { ok: false, status: 400, error: "The signature is missing or malformed." };
  const option = round.options.find((o) => o.id === input.choice);
  if (!option) return { ok: false, status: 400, error: "That option is not on this ballot." };
  const address = normalizeAddress(input.address);
  if (isExcluded(round, address)) return { ok: false, status: 403, error: "Team and reward wallets do not vote." };
  const weight = weightOf(round, holders, address);
  if (weight === 0n) return { ok: false, status: 403, error: `This wallet held no ${round.token.symbol} when the round opened.` };
  let signer: string;
  try {
    signer = (await recoverMessageAddress({ message: voteMessage(round, option, address), signature: input.signature as `0x${string}` })).toLowerCase();
  } catch {
    return { ok: false, status: 400, error: "The signature could not be read." };
  }
  if (signer !== address) return { ok: false, status: 400, error: "The signature does not match this wallet." };
  return { ok: true, vote: { round: round.id, address, choice: option.id, signature: input.signature, weight: weight.toString(), votedAt: now.toISOString() } };
}


/**
 * Re-checks a stored vote when a round is recounted: the option is on the ballot, the
 * signature was made by the wallet for exactly this round and choice, and the wallet had
 * a balance in the snapshot. Weight is taken from the snapshot, never from the stored vote.
 */
export async function verifyStoredVote(round: Round, holders: Holders, vote: Pick<Vote, "address" | "choice" | "signature" | "votedAt">): Promise<boolean> {
  if (!isAddress(vote.address) || typeof vote.signature !== "string" || !SIGNATURE_RE.test(vote.signature)) return false;
  const option = round.options.find((o) => o.id === vote.choice);
  if (!option) return false;
  if (typeof vote.votedAt === "string" && Date.parse(vote.votedAt) >= Date.parse(round.closesAt)) return false;
  const address = normalizeAddress(vote.address);
  if (isExcluded(round, address) || weightOf(round, holders, address) === 0n) return false;
  try {
    const signer = await recoverMessageAddress({ message: voteMessage(round, option, address), signature: vote.signature as `0x${string}` });
    return signer.toLowerCase() === address;
  } catch {
    return false;
  }
}
