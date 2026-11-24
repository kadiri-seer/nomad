/**
 * Nomad's paymaster service (ERC-7677): pm_getPaymasterStubData and pm_getPaymasterData for NomadPaymaster on
 * Robinhood Chain. See lib/server/sponsor.ts for who pays for what.
 */
import { json, rateLimited, sponsorDeps } from "@/lib/server/account-routes";
import { privyKeysReady, privyUser } from "@/lib/server/privy-auth";
import { sponsor, SponsorError, stubData } from "@/lib/server/sponsor";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { id?: unknown; method?: unknown; params?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Not JSON." } }, 400);
  }
  const id = body.id ?? null;
  const reply = (result: unknown) => json({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string, status = 200) => json({ jsonrpc: "2.0", id, error: { code, message } }, status);
  const params = Array.isArray(body.params) ? body.params : [];
  if (await rateLimited(req, "paymaster", 60)) return error(-32005, "Too many requests. Wait a minute and try again.", 429);
  // Free operations need a person signed in with Google on this site; anything else is paid from credits.
  let user: string | null = null;
  if (body.method === "pm_getPaymasterData") {
    user = await privyUser((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    // If Privy's keys are out of reach, sign-up keeps working under the per-account and global limits.
    if (!user && !(await privyKeysReady())) user = "*";
  }
  const d = sponsorDeps(user);
  if (typeof d === "string") return error(-32001, d);
  try {
    if (body.method === "pm_getPaymasterStubData") return reply(stubData(d.sponsor, params));
    if (body.method === "pm_getPaymasterData") {
      const { kind: _k, paidBy: _p, ...data } = await sponsor(d.sponsor, params);
      return reply(data);
    }
    return error(-32601, "Only pm_getPaymasterStubData and pm_getPaymasterData are supported.");
  } catch (e) {
    if (e instanceof SponsorError) return error(e.status === 402 ? -32002 : -32602, e.message);
    return error(-32603, "Gas could not be arranged right now. Nothing was sent. Try again.");
  }
}
