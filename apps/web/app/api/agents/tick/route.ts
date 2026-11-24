/**
 * The runner's schedule calls this every 15 minutes (GitHub Actions, proven by its OpenID Connect token). It runs the
 * agents that are due, within a time budget, one at a time.
 */
import { json } from "@/lib/server/account-routes";
import { agentEnv, runnerDeps } from "@/lib/server/agent-api";
import { verifyGithubToken } from "@/lib/server/github-oidc";
import { tick } from "@/lib/server/runner";
import { noteRun } from "@/lib/server/agent-health";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    await verifyGithubToken(token);
  } catch {
    return json({ error: "Not the runner's schedule." }, 401);
  }
  const env = agentEnv();
  if (!env) return json({ ran: 0, note: "Agents are not switched on on this site yet." });
  if (!(await env.store.lock("agent-tick", 290))) return json({ ran: 0, note: "Another run is in progress." });
  try {
    await noteRun(env.store, "github");
    const ran = await tick(runnerDeps(env), 240_000);
    return json({ ran: ran.length, agents: ran.map((r) => ({ id: r.id, moves: r.lines.length })) });
  } finally {
    await env.store.unlock("agent-tick");
  }
}
