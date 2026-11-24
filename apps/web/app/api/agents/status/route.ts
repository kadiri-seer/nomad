/**
 * Whether agents can run on this deployment, which AI answers them (and whether it answered a test question, checked
 * at most once an hour), and the wallet that pays Idlex.
 */
import { json } from "@/lib/server/account-routes";
import { agentEnv } from "@/lib/server/agent-api";
import { gemini } from "@/lib/server/gemini";
import { idlexPayer } from "@/lib/server/runner-keys";
import { privyKeysReady } from "@/lib/server/privy-auth";
import { agentHealth, oddsCheck, researchCheck } from "@/lib/server/agent-health";
import { buildCandidates } from "@/lib/server/runner";
import { stoa } from "@/lib/server/stoa";
import { rushrSafety } from "@/lib/server/rushr";
import { toolKit } from "@/lib/server/agent-tools";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  // ?check=1: the live check of everything agents depend on (cached for ten minutes).
  const check = new URL(req.url).searchParams.get("check");
  if (check === "odds") {
    const env = agentEnv();
    if (!env) return json({ ready: false });
    // The same candidates the runner uses (with Rushr's verdicts), so this never caches a list without them.
    const candidates = await buildCandidates(stoa(), env.store, (a) => rushrSafety(a)).catch(() => []);
    const token = (candidates.find((c) => c.passes) ?? candidates[0])?.address ?? null;
    return json(await oddsCheck(env.store, token));
  }
  if (check === "research") {
    const env = agentEnv();
    if (!env) return json({ ready: false });
    return json(await researchCheck(env.store, () => toolKit({ cache: env.store })));
  }
  if (check === "1") {
    const env = agentEnv();
    if (!env) return json({ ready: false });
    return json(await agentHealth(env.store));
  }
  const env = agentEnv();
  const key = process.env.GEMINI_API_KEY?.trim();
  let probe: { ok: boolean; model?: string; detail: string } | null = null;
  if (env && key) {
    probe = await env.store.cacheGet<typeof probe>("gemini-probe");
    if (!probe) {
      probe = await gemini(key, { model: process.env.GEMINI_MODEL?.trim() })
        .probe()
        .catch((e) => ({ ok: false, detail: String((e as Error).message).slice(0, 120) }));
      await env.store.cacheSet("gemini-probe", probe, probe.ok ? 3600 : 120);
    }
  }
  return json({ ready: !!env, ai: key ? "gemini" : "idlex", aiAnswering: probe?.ok ?? null, aiModel: probe?.model ?? null, aiDetail: probe?.detail ?? null, idlexPayer: env ? idlexPayer(env.secret).address : null, signInCheck: await privyKeysReady().catch(() => false), oddsEngine: !!process.env.ODDSENGINE_API_KEY?.trim() });
}
