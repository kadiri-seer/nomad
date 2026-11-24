/**
 * Gemini (Google's API, free tier with Flash-Lite), as the agent runner uses it: one short text answer per question,
 * within the run. Answers are data written by a model, never instructions.
 */
const API = "https://generativelanguage.googleapis.com/v1beta/models";
/** Tried in order: the configured model, the current Flash-Lite, Google's rolling alias for it, then Flash. */
const MODELS = ["gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-flash-latest"];
/** Busy, rate-limited or not offered: worth trying the next model. */
const tryNext = (status: number) => status === 404 || status === 429 || status >= 500;

import type { ToolKit } from "./agent-tools";

type Part = { text?: string; functionCall?: { id?: string; name: string; args?: unknown }; thoughtSignature?: string; [k: string]: unknown };
type Content = { role: string; parts: Part[] };

/** How far one run's research may go: tool calls, rounds of the conversation, and time. */
export type ResearchLimits = { maxCalls: number; maxRounds: number; maxMs: number; maxTokens: number };
export const RESEARCH_LIMITS: ResearchLimits = { maxCalls: 6, maxRounds: 4, maxMs: 100_000, maxTokens: 900 };

export function gemini(apiKey: string, opts: { model?: string; fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const models = [...new Set([opts.model, ...MODELS].filter((m): m is string => !!m && /^[a-z0-9.-]{3,60}$/.test(m)))];
  let working: string | null = null;
  const now = opts.now ?? (() => Date.now());

  /** One request; tries the models in order until one answers, then keeps to it for the rest of the run. */
  async function generate(body: Record<string, unknown>, pinned: string | null): Promise<{ model: string; j: { candidates?: { content?: Content }[] } } | null> {
    for (const model of pinned ? [pinned] : working ? [working, ...models.filter((m) => m !== working)] : models) {
      const r = await fetchImpl(`${API}/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
        cache: "no-store"
      });
      if (tryNext(r.status) && !pinned) continue;
      if (!r.ok) return null;
      working = model;
      return { model, j: await r.json().catch(() => ({})) };
    }
    return null;
  }

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
    /**
     * A question the AI may answer after using research tools: it calls tools from `kit` (at most `limits.maxCalls`,
     * over at most `limits.maxRounds` rounds and `limits.maxMs`), then answers in text. Null when no model answered.
     */
    async withTools(prompt: string, system: string, kit: ToolKit, limits: ResearchLimits = RESEARCH_LIMITS): Promise<{ text: string; used: string[] } | null> {
      const started = now();
      const declarations = await kit.declarations().catch(() => []);
      const contents: Content[] = [{ role: "user", parts: [{ text: prompt.slice(0, 12_000) }] }];
      let calls = 0;
      let model: string | null = null;
      for (let round = 0; round <= limits.maxRounds; round++) {
        const last = round === limits.maxRounds || calls >= limits.maxCalls || now() - started > limits.maxMs;
        const body: Record<string, unknown> = {
          systemInstruction: { parts: [{ text: system.slice(0, 4000) }] },
          contents,
          generationConfig: { maxOutputTokens: limits.maxTokens, temperature: 0.2 }
        };
        if (declarations.length) {
          body.tools = [{ functionDeclarations: declarations }];
          body.toolConfig = { functionCallingConfig: { mode: last ? "NONE" : "AUTO" } };
        }
        const res = await generate(body, model);
        if (!res) return null;
        model = res.model;
        const content = res.j.candidates?.[0]?.content;
        const parts = content?.parts ?? [];
        const asked = parts.filter((p) => p.functionCall && typeof p.functionCall.name === "string");
        if (!asked.length || last) {
          const text = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("").trim();
          return text ? { text: text.slice(0, 4000), used: kit.used() } : null;
        }
        // The model's turn goes back exactly as it came (thought signatures included), then each tool's answer.
        contents.push({ role: "model", parts });
        const answers: Part[] = [];
        for (const p of asked) {
          const fc = p.functionCall!;
          calls += 1;
          const result = calls > limits.maxCalls ? "Not run: this run's research limit is reached. Answer with what you have." : await kit.call(fc.name, fc.args ?? {}).catch(() => "The tool did not answer.");
          answers.push({ functionResponse: { ...(fc.id ? { id: fc.id } : {}), name: fc.name, response: { result } } });
        }
        contents.push({ role: "user", parts: answers });
      }
      return null;
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
