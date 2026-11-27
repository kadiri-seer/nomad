/** Whether the signed-in account is a beta tester. Told only to that account: the request is signed by its wallet. */
import { getAddress, isAddress, type Hex } from "viem";
import { json, rateLimited } from "@/lib/server/account-routes";
import { mainAccountOf, serverClient } from "@/lib/server/agent-exec";
import { isBetaTester } from "@/lib/server/beta";
import { betaMessage } from "@/lib/agents/beta";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (await rateLimited(req, "agent-beta", 20)) return json({ error: "Too many tries. Wait a minute." }, 429);
  let b: { signer?: string; at?: number; signature?: string };
  try {
    b = await req.json();
  } catch {
    return json({ error: "Not JSON." }, 400);
  }
  if (typeof b.signer !== "string" || !isAddress(b.signer, { strict: false })) return json({ error: "signer is not an address." }, 400);
  const at = Number(b.at);
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) > 10 * 60_000) return json({ error: "The signature is too old." }, 400);
  const signer = getAddress(b.signer);
  const ok = typeof b.signature === "string" && (await serverClient().verifyMessage({ address: signer, message: betaMessage(at), signature: b.signature as Hex }).catch(() => false));
  if (!ok) return json({ error: "The signature does not match." }, 403);
  const account = await mainAccountOf(signer).catch(() => null);
  return json({ beta: isBetaTester([signer, account]) });
}
