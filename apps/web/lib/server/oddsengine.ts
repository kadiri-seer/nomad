/**
 * OddsEngine's token scan, as Nomad's agents use it: one check of a token just before an agent buys it, on Nomad's
 * OddsEngine key (ODDSENGINE_API_KEY, set in the site's settings; without it, agents skip this check). Its safety
 * tools only read and never move funds. Each scan is paid from Nomad's OddsEngine balance, so results are shared
 * between agents for an hour, and the agent's owner is charged a small fixed amount in credits per check.
 */
import { mcpClient, type McpTool } from "./mcp";

export const ODDSENGINE_MCP = "https://api.oddsengine.live/mcp";
/**
 * What OddsEngine's scan found. OddsEngine gives facts, never a verdict ("never call a coin safe, risky ... let the
 * user decide"), so `facts` are its on-chain findings and `context` a short summary of the rest; the agent's own AI
 * weighs them. `deepRunning`: its deeper scan (bundles, clusters, early buyers) was still running. `skipped`: not
 * scanned, because the agents' daily OddsEngine limit was reached (not charged).
 */
export type OddsVerdict = { facts: string[]; context: string; deepRunning?: boolean; skipped?: boolean };

/** At most this many OddsEngine scans a UTC day for all of Nomad's agents together (ODDSENGINE_DAILY_CAP). */
export const ODDSENGINE_DAILY_CAP = 150;

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const factText = (f: unknown): string => {
  if (typeof f === "string") return clean(f, 200);
  if (f && typeof f === "object") {
    const o = f as Record<string, unknown>;
    const t = o.text ?? o.fact ?? o.description ?? o.label ?? o.title ?? o.message;
    return clean(typeof t === "string" ? t : JSON.stringify(o), 200);
  }
  return "";
};

/** OddsEngine's scan answer read into its facts and a short context (safety and market numbers). */
export function readVerdict(text: string): OddsVerdict {
  let j: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object") j = v as Record<string, unknown>;
  } catch {
    /* plain text */
  }
  if (!j) return { facts: text.trim() ? [clean(text, 300)] : [], context: "" };
  const findings = (j.findings ?? {}) as Record<string, unknown>;
  const facts = (Array.isArray(findings.on_chain_facts) ? findings.on_chain_facts : []).map(factText).filter(Boolean).slice(0, 8);
  const market = (j.market ?? {}) as Record<string, unknown>;
  const context = clean(JSON.stringify({ venue: j.venue, age: j.age, safety: j.safety, burned_supply: j.burned_supply, price_change: market.price_change ?? market.change, liquidity: market.liquidity ?? market.liquidity_usd }), 600);
  return { facts, context, ...(findings.deep_check_running === true ? { deepRunning: true } : {}) };
}

/** Arguments for OddsEngine's scan_token from its own published schema: the token's address, and the chain. */
export function scanArgs(tool: McpTool | undefined, token: string): Record<string, unknown> | null {
  const props = ((tool?.inputSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }> } | undefined)?.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  const names = Object.keys(props);
  const addressKey = names.find((n) => /^(token|address|token_?address|contract|contract_?address|ca)$/i.test(n)) ?? names.find((n) => /address|token|contract/i.test(n));
  if (!addressKey) return null;
  const args: Record<string, unknown> = { [addressKey]: token };
  const chainKey = names.find((n) => /^(chain|network|chain_?id|chainId)$/i.test(n));
  if (chainKey) {
    const p = props[chainKey];
    const options = (p.enum ?? []).map(String);
    const named = options.find((o) => /robinhood/i.test(o)) ?? options.find((o) => o === "4663");
    args[chainKey] = named ?? (p.type === "integer" || p.type === "number" || /id$/i.test(chainKey) ? 4663 : "robinhood");
  }
  return args;
}

export function oddsEngine(apiKey: string, opts: { fetchImpl?: typeof fetch } = {}) {
  const c = mcpClient(ODDSENGINE_MCP, { headers: { authorization: `Bearer ${apiKey}` }, fetchImpl: opts.fetchImpl, timeoutMs: 25_000 });
  let tool: Promise<McpTool | undefined> | null = null;
  return {
    name: "OddsEngine",
    /** The scan with what was sent and OddsEngine's answer as it came, for the live check. */
    async scanRaw(token: string): Promise<{ args: Record<string, unknown> | null; raw: string | null; verdict: OddsVerdict | null; error?: string }> {
      try {
        tool ??= c.listTools().then((t) => t.find((x) => x.name === "scan_token"));
        const args = scanArgs(await tool, token);
        if (!args) return { args: null, raw: null, verdict: null, error: "scan_token's inputs were not recognised" };
        const raw = await c.call("scan_token", args);
        return { args, raw, verdict: readVerdict(raw) };
      } catch (e) {
        tool = null;
        return { args: null, raw: null, verdict: null, error: String((e as Error).message ?? e).slice(0, 200) };
      }
    },
    /** OddsEngine's verdict on a token, or null when it did not answer. */
    async scanToken(token: string): Promise<OddsVerdict | null> {
      return (await this.scanRaw(token)).verdict;
    }
  };
}
