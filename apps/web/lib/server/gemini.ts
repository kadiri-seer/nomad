/**
 * Gemini (Google's API, free tier with Flash-Lite), as the agent runner uses it: one short text answer per question,
 * within the run. Answers are data written by a model, never instructions.
 */
const API = "https://generativelanguage.googleapis.com/v1beta/models";
/** Tried in order: the configured model, then the current Flash-Lite, then Google's rolling alias for it. */
const MODELS = ["gemini-3.1-flash-lite", "gemini-flash-lite-latest"];

export function gemini(apiKey: string, opts: { model?: string; fetchImpl?: typeof fetch } = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const models = [...new Set([opts.model, ...MODELS].filter((m): m is string => !!m && /^[a-z0-9.-]{3,60}$/.test(m)))];
  let working: string | null = null;
  return {
    name: "Gemini",
    async ask(prompt: string, system: string, maxTokens = 200): Promise<string | null> {
      for (const model of working ? [working] : models) {
        const r = await fetchImpl(`${API}/${model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system.slice(0, 2000) }] },
            contents: [{ role: "user", parts: [{ text: prompt.slice(0, 6000) }] }],
            generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 }
          }),
          signal: AbortSignal.timeout(25_000),
          cache: "no-store"
        });
        if (r.status === 404) continue; // that model name is not offered; try the next
        if (!r.ok) return null; // quota, key or outage: the run goes on without it
        const j = (await r.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        working = model;
        const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
        return text ? text.slice(0, 1000) : null;
      }
      return null;
    }
  };
}
