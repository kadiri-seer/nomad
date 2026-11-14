import { json } from "@/lib/vote/server";
import { suggestionStore } from "@/lib/vote/suggest-server";

export const dynamic = "force-dynamic";

/** New site suggestions for the round job to turn into GitHub issues. */
export async function GET() {
  const store = suggestionStore();
  if (!store) return json({ error: "Suggestion storage is not connected yet." }, 503);
  try {
    return json({ suggestions: await store.pending() });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
