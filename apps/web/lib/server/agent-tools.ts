/**
 * The research tools Nomad's agents can use during a run: read-only tools from the keyless hosted servers of projects
 * Nomad works with. Each is on a fixed list (the ones reviewed for Nomad AI); nothing on these lists signs, sends,
 * posts or spends. Every answer is capped in size and checked by Venin before an agent's AI reads it; an answer with
 * planted instructions is withheld. Answers stay data: the runner's own checks decide every trade.
 */
import { mcpClient, type McpTool } from "./mcp";
import { RUSHR_API, RUSHR_TOOLS, runRushrTool } from "./rushr";
import { veninCheck, type VeninVerdict } from "./venin-check";

/** An MCP server, or Rushr's public REST API (`rest: "rushr"`), whose tools are defined in rushr.ts. */
export type ToolServer = { id: string; name: string; url: string; headers?: Record<string, string>; tools: string[]; rest?: "rushr"; fallbackUrl?: string };

/** The servers and their allowed tools. Addresses are exact; nothing else is ever called. */
export const TOOL_SERVERS: ToolServer[] = [
  {
    id: "hey",
    name: "HEY Research",
    url: "https://heyresearch.xyz/mcp",
    headers: { "x-hey-integration": "nomad-agents" },
    tools: ["research_answer", "find_projects", "get_project_snapshot", "get_changes", "get_project_timeline", "explain_fact", "get_evidence", "get_token_market", "get_contract", "project_diff", "chain_overview", "market_integrity"]
  },
  { id: "zolva", name: "Zolva", url: "https://zolvaagent.app/mcp", tools: ["list_agents", "get_agent", "verify_agent", "list_markets", "get_market", "recent_activity", "get_consensus"] },
  // Reads earn no referral; when QHooks' referral lookup is down, its plain address still answers.
  { id: "qhooks", name: "QHooks", url: "https://qhooks.com/mcp?ref=nomad", fallbackUrl: "https://qhooks.com/mcp", tools: ["token_info", "list_launches", "agent_stats", "hooks_catalog", "list_callers", "caller_record", "compete_standings"] },
  { id: "stoa", name: "Stoa", url: "https://stoadex.com/mcp", tools: ["market_context", "safety_check", "spotlight", "stock_tokens"] },
  { id: "rushr", name: "Rushr", url: RUSHR_API, rest: "rushr", tools: Object.values(RUSHR_TOOLS).map((t) => t.declaration.name) },
  // Read only: markets, marks, quotes and records. Nothing tied to one account, and agents never trade options.
  { id: "hedgehood", name: "Hedgehood", url: "https://mcp.hedgehood.io/mcp", tools: ["list_markets", "list_instruments", "get_mark", "get_quote", "get_leaderboard", "get_agent_record", "list_vaults", "vault_status"] },
  // Read only: agents' credit records and pools. No borrowing quotes or credit lines: agents never borrow.
  { id: "priors", name: "Priors", url: "https://mcp.priors.trade/mcp", tools: ["agent_record", "score_of", "credit_history", "pool_stats", "stock_assets", "recent_activity", "desk_record", "find_agents", "agent_page"] }
];

/** One tool answer, as much as an agent's AI reads of it. */
export const MAX_TOOL_ANSWER_CHARS = 3500;
const MAX_ARGS_CHARS = 2000;

export type FunctionDeclaration = { name: string; description: string; parameters?: Record<string, unknown> };
export type ToolKit = {
  declarations(): Promise<FunctionDeclaration[]>;
  call(name: string, args: unknown): Promise<string>;
  /** The services whose tools answered in this run, by name. */
  used(): string[];
};

const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
const plain = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/g, "").slice(0, max) : "");

/** A tool's input schema in the subset Gemini's function declarations take. */
export function geminiSchema(s: unknown, depth = 0): Record<string, unknown> {
  const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
  let type = Array.isArray(o.type) ? o.type.find((t) => t !== "null") : o.type;
  if (typeof type !== "string" || !TYPES.has(type)) type = o.properties ? "object" : "string";
  const out: Record<string, unknown> = { type };
  const desc = plain(o.description, 200);
  if (desc) out.description = desc;
  if (Array.isArray(o.enum)) {
    const e = o.enum.filter((x): x is string => typeof x === "string").slice(0, 30);
    if (e.length) out.enum = e;
  }
  if (type === "array") out.items = depth < 3 ? geminiSchema(o.items, depth + 1) : { type: "string" };
  if (type === "object") {
    const props: Record<string, unknown> = {};
    if (depth < 3 && o.properties && typeof o.properties === "object") {
      for (const [k, v] of Object.entries(o.properties as Record<string, unknown>).slice(0, 20)) if (/^[A-Za-z0-9_]{1,64}$/.test(k)) props[k] = geminiSchema(v, depth + 1);
    }
    out.properties = props;
    const req = Array.isArray(o.required) ? o.required.filter((r): r is string => typeof r === "string" && r in props) : [];
    if (req.length) out.required = req;
  }
  return out;
}

type Cache = { cacheGet<T>(k: string): Promise<T | null>; cacheSet(k: string, v: unknown, s: number): Promise<void> };
type Client = ReturnType<typeof mcpClient>;

/** A server's client that switches to its plain address (for good, this run) when the main one fails. */
export function withFallback(s: ToolServer, fetchImpl?: typeof fetch): Client {
  const main = mcpClient(s.url, { headers: s.headers, fetchImpl, timeoutMs: 15_000 });
  if (!s.fallbackUrl) return main;
  const plain = mcpClient(s.fallbackUrl, { headers: s.headers, fetchImpl, timeoutMs: 15_000 });
  let use: Client = main;
  const run = async <T>(f: (c: Client) => Promise<T>) => {
    try {
      return await f(use);
    } catch (e) {
      if (use === plain) throw e;
      use = plain;
      return f(use);
    }
  };
  return { listTools: () => run((c) => c.listTools()), call: (n, a) => run((c) => c.call(n, a)) };
}

export function toolKit(deps: { cache: Cache; fetchImpl?: typeof fetch; servers?: ToolServer[]; venin?: (path: string, text: string) => Promise<VeninVerdict> }): ToolKit {
  const servers = deps.servers ?? TOOL_SERVERS;
  const clients = new Map<string, Client>();
  const client = (s: ToolServer) => {
    let c = clients.get(s.id);
    if (!c) clients.set(s.id, (c = withFallback(s, deps.fetchImpl)));
    return c;
  };
  const used = new Set<string>();
  const byName = new Map<string, { server: ToolServer; tool: string }>();
  const venin = deps.venin ?? ((p: string, t: string) => veninCheck(p, t));

  async function toolsOf(s: ToolServer): Promise<McpTool[]> {
    const key = `agent-tools:${s.id}`;
    const cached = await deps.cache.cacheGet<McpTool[]>(key);
    if (cached) return cached;
    const listed = (await client(s).listTools()).filter((t) => s.tools.includes(t.name));
    await deps.cache.cacheSet(key, listed, 6 * 3600);
    return listed;
  }

  return {
    async declarations() {
      const out: FunctionDeclaration[] = [];
      const lists = await Promise.all(servers.filter((s) => !s.rest).map((s) => toolsOf(s).then((t) => ({ s, t })).catch(() => ({ s, t: [] as McpTool[] }))));
      for (const s of servers.filter((x) => x.rest === "rushr")) {
        for (const t of Object.values(RUSHR_TOOLS)) {
          byName.set(t.declaration.name, { server: s, tool: t.declaration.name });
          out.push(t.declaration);
        }
      }
      for (const { s, t } of lists) {
        for (const tool of t) {
          const name = `${s.id}_${tool.name}`.slice(0, 64);
          byName.set(name, { server: s, tool: tool.name });
          const params = geminiSchema(tool.inputSchema ?? { type: "object", properties: {} });
          const hasParams = Object.keys((params.properties as object) ?? {}).length > 0;
          out.push({ name, description: `${s.name}: ${plain(tool.description, 300) || tool.name}`, ...(hasParams ? { parameters: params } : {}) });
        }
      }
      return out;
    },
    async call(name, args) {
      const t = byName.get(name);
      if (!t) return "Not run: there is no tool by that name.";
      const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      if (JSON.stringify(a).length > MAX_ARGS_CHARS) return "Not run: the request was too long.";
      let text: string;
      try {
        text = t.server.rest === "rushr" ? await runRushrTool(t.tool, a, deps.fetchImpl) : await client(t.server).call(t.tool, a);
      } catch (e) {
        return `${t.server.name} did not answer: ${plain((e as Error).message, 120)}`;
      }
      used.add(t.server.name);
      const v = await venin(`${t.server.id}/${t.tool}.md`, text);
      if (v.planted > 0) return `Withheld: Venin found planted instructions in ${t.server.name}'s answer, so it is not shown.`;
      return text.length > MAX_TOOL_ANSWER_CHARS ? `${text.slice(0, MAX_TOOL_ANSWER_CHARS)} [cut]` : text;
    },
    used: () => [...used]
  };
}
