/** Registers an agent after its mint: checks the mint, owner and wallet on-chain, stores it and schedules its first run. */
import { json } from "@/lib/server/account-routes";
import { AgentApiError, agentEnv, checkRegistration, publicAgent, type Registration } from "@/lib/server/agent-api";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const env = agentEnv();
  if (!env) return json({ error: "Agents are not switched on on this site yet." }, 503);
  let body: Registration;
  try {
    body = (await req.json()) as Registration;
  } catch {
    return json({ error: "Not JSON." }, 400);
  }
  try {
    const agent = await checkRegistration(env, body);
    if (!(await env.store.create(agent))) return json({ error: "This agent is already registered." }, 409);
    await env.store.addMove(agent.id, { at: agent.createdAt, text: `Created. Its first run is within the next 15 minutes.`, tx: agent.mintTx });
    await env.store.schedule(agent.id, agent.createdAt);
    return json({ agent: publicAgent(agent) });
  } catch (e) {
    if (e instanceof AgentApiError) return json({ error: e.message }, e.status);
    return json({ error: "The agent could not be registered right now. Try again." }, 500);
  }
}
