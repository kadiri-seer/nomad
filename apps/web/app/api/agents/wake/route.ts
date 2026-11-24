/**
 * Vercel's own schedule (vercel.json, every 15 minutes) calls this to run the agents that are due. GitHub's schedule
 * (/api/agents/tick) stays as a backup; a shared lock keeps the two from running at once.
 *
 * A run here only does what the schedule asks anyway: it runs agents whose time has come, within the same limits.
 * When CRON_SECRET is set, Vercel sends it and it is required. Without it, any caller can at most start one run every
 * 10 minutes, so calling it early or often changes nothing.
 */
import { json } from "@/lib/server/account-routes";
import { agentEnv, runnerDeps } from "@/lib/server/agent-api";
import { tick } from "@/lib/server/runner";
import { noteRun } from "@/lib/server/agent-health";
import { runFeeKeeper } from "@/lib/server/fee-keeper";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function wake(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return json({ error: "Not the schedule." }, 401);
  const env = agentEnv();
  if (!env) return json({ ran: 0, note: "Agents are not switched on on this site yet." });
  // At most one run every 10 minutes from here, whoever calls.
  if (!(await env.store.lock("agent-wake", 600))) return json({ ran: 0, note: "Ran recently." });
  if (!(await env.store.lock("agent-tick", 290))) return json({ ran: 0, note: "Another run is in progress." });
  try {
    await noteRun(env.store, "vercel");
    const ran = await tick(runnerDeps(env), 240_000);
    return json({ ran: ran.length });
  } finally {
    await env.store.unlock("agent-tick");
    // Keeps the agent fee at $5 (at most every 10 minutes); its own errors never stop the runner.
    await runFeeKeeper(env.store, env.secret).catch(() => null);
  }
}

export const GET = wake;
export const POST = wake;
