/**
 * Venin's check on the instructions someone is about to give a new agent, before it is minted: planted orders
 * (hidden text, or orders pasted in from somewhere) are caught while nothing has been paid yet.
 * POST {instructions} -> {ok, ran, says}.
 */
import { json, rateLimited } from "@/lib/server/account-routes";
import { veninCheck } from "@/lib/server/venin-check";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (await rateLimited(req, "agent-check", 30)) return json({ error: "Too many requests. Wait a minute and try again." }, 429);
  const text = await req.text();
  if (text.length > 20_000) return json({ error: "Instructions must be at most 4,000 characters." }, 413);
  let instructions = "";
  try {
    instructions = String((JSON.parse(text) as { instructions?: unknown }).instructions ?? "");
  } catch {
    return json({ error: "Send JSON: {instructions}." }, 400);
  }
  if (instructions.length > 4000) return json({ error: "Instructions must be at most 4,000 characters." }, 400);
  const v = await veninCheck("agent/INSTRUCTIONS.md", instructions);
  return json({ ok: v.planted === 0, ran: v.ran, says: v.says });
}
