import { json } from "@/lib/vote/server";
import { clientIp } from "@/lib/vote/suggest";
import { loadSuggestions, suggestionStore } from "@/lib/vote/suggest-server";

export const dynamic = "force-dynamic";

/** Listed suggestions (those with an open GitHub issue) with their support, most backed first. */
export async function GET() {
  try {
    const published = await loadSuggestions();
    const store = suggestionStore();
    const support = store ? await store.supportMap() : {};
    const items = published
      .map((p) => ({ ...p, support: support[String(p.issue)] ?? 0 }))
      .sort((a, b) => b.thumbs + b.support - (a.thumbs + a.support) || a.issue - b.issue);
    return json({ items, storage: store !== null });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}

/** Sends a new suggestion: `{ name, why, website }`. `website` is a trap for bots and must stay empty. */
export async function POST(req: Request) {
  const store = suggestionStore();
  if (!store) return json({ error: "Suggestion storage is not connected yet." }, 503);
  const text = await req.text();
  if (text.length > 4096) return json({ error: "Request too large." }, 413);
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(text);
  } catch {
    return json({ error: "Request is not valid JSON." }, 400);
  }
  try {
    const r = await store.submit({ name: input.name, why: input.why, website: input.website, ip: clientIp(req.headers), now: new Date(), published: await loadSuggestions() });
    if (!r.ok) return json({ error: r.error }, r.status);
    return json(r);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
