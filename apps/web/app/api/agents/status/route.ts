/** Whether agents can run on this deployment, and the wallet that pays Idlex for their AI jobs. */
import { json } from "@/lib/server/account-routes";
import { agentEnv } from "@/lib/server/agent-api";
import { idlexPayer } from "@/lib/server/runner-keys";

export const dynamic = "force-dynamic";

export async function GET() {
  const env = agentEnv();
  return json({ ready: !!env, ai: process.env.GEMINI_API_KEY?.trim() ? "gemini" : "idlex", idlexPayer: env ? idlexPayer(env.secret).address : null });
}
