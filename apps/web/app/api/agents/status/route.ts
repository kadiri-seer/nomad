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
  let aiOk: boolean | null = null;
  if (env && key) {
    aiOk = await env.store.cacheGet<boolean>("gemini-ok");
    if (aiOk === null) {
      aiOk = !!(await gemini(key, { model: process.env.GEMINI_MODEL?.trim() }).ask("Reply with the word OK.", "Answer in one word.", 5).catch(() => null));
      await env.store.cacheSet("gemini-ok", aiOk, aiOk ? 3600 : 300);
    }
  }
  return json({ ready: !!env, ai: key ? "gemini" : "idlex", aiAnswering: aiOk, idlexPayer: env ? idlexPayer(env.secret).address : null });
}
