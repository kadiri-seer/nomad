/**
 * Nomad's paymaster service (ERC-7677): pm_getPaymasterStubData and pm_getPaymasterData for NomadPaymaster on
 * Robinhood Chain. See lib/server/sponsor.ts for who pays for what.
 */
import { json, sponsorDeps } from "@/lib/server/account-routes";
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
  const d = sponsorDeps();
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
