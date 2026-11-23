/**
 * Whether agents can run on this deployment, which AI answers them (and whether it answered a test question, checked
 * at most once an hour), and the wallet that pays Idlex.
 */
import { json } from "@/lib/server/account-routes";
import { agentEnv } from "@/lib/server/agent-api";
import { gemini } from "@/lib/server/gemini";
import { idlexPayer } from "@/lib/server/runner-keys";

export const dynamic = "force-dynamic";

export async function GET() {
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
  return json({ ready: !!env, ai: key ? "gemini" : "idlex", aiAnswering: probe?.ok ?? null, aiModel: probe?.model ?? null, aiDetail: probe?.detail ?? null, idlexPayer: env ? idlexPayer(env.secret).address : null });
}
