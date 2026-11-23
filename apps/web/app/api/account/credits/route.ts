/**
 * An account's credits: GET ?account=0x... for the balance (held gas settled first), POST {account, txHash} to count
 * a top-up the account made on-chain.
 */
import { getAddress } from "viem";
import { redisFromEnv } from "@/lib/vote/redis";
import { creditsDeps, json } from "@/lib/server/account-routes";
import { balanceOf, claimTopUp, CreditsError, settle } from "@/lib/server/credits";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account") ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) return json({ error: "account must be an address." }, 400);
  const redis = redisFromEnv();
  if (!redis) return json({ error: "Storage is not connected on this site." }, 503);
  const deps = creditsDeps(redis);
  try {
    await settle(deps, getAddress(account));
  } catch {
    /* show the balance as it is */
  }
  const b = await balanceOf(deps, getAddress(account));
  return json({ balanceUsd: b.balanceUsd, heldUsd: b.heldUsd, availableUsd: b.availableUsd });
}

export async function POST(req: Request) {
  const redis = redisFromEnv();
  if (!redis) return json({ error: "Storage is not connected on this site." }, 503);
  let body: { account?: unknown; txHash?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send JSON: {account, txHash}." }, 400);
  }
  try {
    const r = await claimTopUp(creditsDeps(redis), String(body.account ?? ""), String(body.txHash ?? ""));
    return json({ addedUsd: r.addedUsd, balanceUsd: r.balance.balanceUsd, availableUsd: r.balance.availableUsd });
  } catch (e) {
    if (e instanceof CreditsError) return json({ error: e.message }, e.status);
    return json({ error: "The top-up could not be checked right now. Nothing was lost: try again." }, 502);
  }
}
