/**
 * One agent: what anyone may see of it (GET), and its creator's own requests (POST, signed by the creator's Google
 * wallet, which owns the agent's wallet): see its moves, reports and holdings; pause, resume or set how often it runs;
 * read or change its instructions.
 */
import { keccak256, toHex, verifyMessage, type Hex } from "viem";
import { veninCheck } from "@/lib/server/venin-check";
import { json } from "@/lib/server/account-routes";
import { agentEnv, ownerAgent, publicAgent } from "@/lib/server/agent-api";
import { ownerActionMessage, RUN_EVERY_HOURS } from "@/lib/agents/shared";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const env = agentEnv();
  if (!env || !/^\d{1,30}$/.test(id)) return json({ error: "Not found." }, 404);
  const a = await env.store.get(id);
  if (!a) return json({ error: "Not found." }, 404);
  return json({ agent: publicAgent(a) });
}

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const env = agentEnv();
  if (!env || !/^\d{1,30}$/.test(id)) return json({ error: "Not found." }, 404);
  const a = await env.store.get(id);
  if (!a) return json({ error: "Not found." }, 404);
  let b: { action?: string; at?: number; signature?: string; runEveryHours?: number; instructions?: string };
  try {
    b = await req.json();
  } catch {
    return json({ error: "Not JSON." }, 400);
  }
  const text = typeof b.instructions === "string" ? b.instructions.replace(/\r\n/g, "\n").trim() : "";
  const action =
    b.action === "pause" || b.action === "resume"
      ? b.action
      : b.action === "schedule" && (RUN_EVERY_HOURS as readonly number[]).includes(Number(b.runEveryHours))
        ? `run every ${Number(b.runEveryHours)} hours`
        : b.action === "read"
          ? "read instructions"
          : b.action === "view"
            ? "view"
          : b.action === "instructions"
            ? `set instructions ${keccak256(toHex(text))}`
            : null;
  if (!action) return json({ error: "Unknown change." }, 400);
  const at = Number(b.at);
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) > 10 * 60_000) return json({ error: "The signature is too old. Try again." }, 400);
  const ok = typeof b.signature === "string" && (await verifyMessage({ address: a.signer, message: ownerActionMessage(id, action, at), signature: b.signature as Hex }).catch(() => false));
  if (!ok) return json({ error: "Only the agent's creator can change it." }, 403);
  // Its instructions are private: only its creator reads or changes them. A Trader follows Nomad's rules instead.
  if (b.action === "read") return json({ instructions: a.instructions ?? "" });
  if (b.action === "view") return json({ agent: ownerAgent(a), moves: await env.store.moves(id, 30), positions: await env.store.positions(id) });
  if (b.action === "instructions") {
    if (a.template === "trader") return json({ error: "A Trader follows Nomad's trading rules and has no instructions to edit." }, 400);
    if (a.template === "blank" && !text) return json({ error: "Instructions must be 1 to 4,000 characters." }, 400);
    if (text.length > 4000) return json({ error: "Instructions must be 1 to 4,000 characters." }, 400);
    if (text && (await veninCheck(`agents/${id}/instructions.md`, text)).planted > 0) return json({ error: "Venin found hidden orders in these instructions, so they were not saved." }, 400);
    if (text) a.instructions = text;
    else delete a.instructions;
    await env.store.save(a);
    await env.store.addMove(id, { at: Date.now(), text: "Its creator changed its instructions." });
    return json({ agent: ownerAgent(a) });
  }
  const now = Date.now();
  if (b.action === "pause") {
    a.status = "paused";
    await env.store.unschedule(id);
    await env.store.addMove(id, { at: now, text: "Paused by its creator." });
  } else if (b.action === "resume") {
    a.status = "active";
    await env.store.schedule(id, now);
    await env.store.addMove(id, { at: now, text: "Resumed by its creator. Its next run is within 15 minutes." });
  } else {
    a.runEveryHours = Number(b.runEveryHours);
    if (a.status === "active") await env.store.schedule(id, Math.min(now + a.runEveryHours * 3_600_000, (a.lastRunAt ?? now) + a.runEveryHours * 3_600_000));
    await env.store.addMove(id, { at: now, text: `Now runs every ${a.runEveryHours} hours.` });
  }
  await env.store.save(a);
  return json({ agent: ownerAgent(a) });
}
