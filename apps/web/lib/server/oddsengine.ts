/**
 * OddsEngine's token scan, as Nomad's agents use it: one check of a token just before an agent buys it, on Nomad's
 * OddsEngine key (ODDSENGINE_API_KEY, set in the site's settings; without it, agents skip this check). Its safety
 * tools only read and never move funds. Each scan is paid from Nomad's OddsEngine balance, so results are shared
 * between agents for an hour, and the agent's owner is charged a small fixed amount in credits per check.
 */
import { mcpClient, type McpTool } from "./mcp";

export const ODDSENGINE_MCP = "https://api.oddsengine.live/mcp";
/** `skipped`: not scanned because the agents' daily OddsEngine limit was reached (not a warning, not charged). */
export type OddsVerdict = { warn: boolean; summary: string; skipped?: boolean };

/** At most this many OddsEngine scans a UTC day for all of Nomad's agents together (ODDSENGINE_DAILY_CAP). */
export const ODDSENGINE_DAILY_CAP = 150;

/** OddsEngine's words for a token it would warn about. */
const WARN = /\b(honeypot|scam|rug|malicious|drainer|blacklist|danger(ous)?|critical|high[ _-]?risk|do not (buy|trade)|avoid|blocked|unsafe)\b/i;

/** Words that say a danger is absent ("not a honeypot", "no scam signals") are not a warning. */
const NEGATED = /\b(no|not|isn't|is not|without|zero|none)\s+(an?\s+|known\s+|obvious\s+)?(honeypot|scam|rug|malicious|drainer|blacklist|danger(ous)?|critical|high[ _-]?risk|blocked|unsafe)\w*/gi;

/** OddsEngine's answer read as a warning or not: its own fields first (safe, risk, verdict), then its words. */
export function readVerdict(text: string): OddsVerdict {
  let j: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object") j = v as Record<string, unknown>;
  } catch {
    /* plain text */
  }
  const field = (k: string) => (j ? j[k] ?? (j.result as Record<string, unknown> | undefined)?.[k] : undefined);
  const risk = String(field("riskLevel") ?? field("risk_level") ?? field("risk") ?? field("verdict") ?? field("rating") ?? "");
  const score = Number(field("riskScore") ?? field("risk_score") ?? NaN);
  const summaryRaw = String(field("summary") ?? field("message") ?? field("verdict") ?? (j ? "" : text)).replace(/\s+/g, " ").trim();
  const warn =
    field("safe") === false ||
    field("isHoneypot") === true ||
    field("honeypot") === true ||
    /^(high|critical|danger|dangerous|unsafe|scam|block|avoid)/i.test(risk) ||
    (Number.isFinite(score) && score >= 70) ||
    WARN.test((j ? `${risk} ${summaryRaw}` : text).replace(NEGATED, ""));
  const summary = (summaryRaw || risk || (warn ? "it flagged the token" : "no warning")).replace(/[^\w $%.,:;()'/-]/g, "").slice(0, 140);
  return { warn, summary };
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
