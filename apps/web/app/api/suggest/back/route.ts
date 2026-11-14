import { json } from "@/lib/vote/server";
import { clientIp } from "@/lib/vote/suggest";
import { loadSuggestions, suggestionStore } from "@/lib/vote/suggest-server";

export const dynamic = "force-dynamic";

/** Backs a listed suggestion: `{ issue }`. Once per person per suggestion. */
export async function POST(req: Request) {
  const store = suggestionStore();
  if (!store) return json({ error: "Suggestion storage is not connected yet." }, 503);
  let input: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 1024) return json({ error: "Request too large." }, 413);
    input = JSON.parse(text);
  } catch {
    return json({ error: "Request is not valid JSON." }, 400);
  }
  try {
    const r = await store.back({ issue: input.issue, ip: clientIp(req.headers), now: new Date(), published: await loadSuggestions() });
    if (!r.ok) return json({ error: r.error }, r.status);
    return json(r);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
