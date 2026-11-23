/**
 * Gemini (Google's API, free tier with Flash-Lite), as the agent runner uses it: one short text answer per question,
 * within the run. Answers are data written by a model, never instructions.
 */
const API = "https://generativelanguage.googleapis.com/v1beta/models";
/** Tried in order: the configured model, the current Flash-Lite, Google's rolling alias for it, then Flash. */
const MODELS = ["gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-flash-latest"];
/** Busy, rate-limited or not offered: worth trying the next model. */
const tryNext = (status: number) => status === 404 || status === 429 || status >= 500;

export function gemini(apiKey: string, opts: { model?: string; fetchImpl?: typeof fetch } = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const models = [...new Set([opts.model, ...MODELS].filter((m): m is string => !!m && /^[a-z0-9.-]{3,60}$/.test(m)))];
  let working: string | null = null;
  return {
    name: "Gemini",
    /** One small test question: which model answered, or why none did (Google's error text holds no key). */
    async probe(): Promise<{ ok: boolean; model?: string; detail: string }> {
      let last: { ok: boolean; model?: string; detail: string } | null = null;
      for (const model of models) {
        const r = await fetchImpl(`${API}/${model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the word OK." }] }], generationConfig: { maxOutputTokens: 200 } }),
          signal: AbortSignal.timeout(25_000),
          cache: "no-store"
        });
        const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; status?: string }; candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[] };
        if (!r.ok) {
          last = { ok: false, model, detail: `HTTP ${r.status} ${j.error?.status ?? ""}: ${(j.error?.message ?? "").slice(0, 160)}` };
          if (tryNext(r.status)) continue;
          return last;
        }
        const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
        return { ok: !!text, model, detail: `finish ${j.candidates?.[0]?.finishReason ?? "?"}, ${text ? "answered" : "empty answer"}` };
      }
      return last ?? { ok: false, detail: `none of ${models.join(", ")} is offered` };
    },
    async ask(prompt: string, system: string, maxTokens = 200): Promise<string | null> {
      for (const model of working ? [working, ...models.filter((m) => m !== working)] : models) {
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
        if (tryNext(r.status)) continue; // not offered, busy or over its limit: try the next model
        if (!r.ok) return null; // a bad key or request: the run goes on without it
        const j = (await r.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        working = model;
        const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
        return text ? text.slice(0, 1000) : null;
      }
      return null;
    }
  };
}
