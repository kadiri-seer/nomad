/**
 * A small MCP client for hosted servers (Streamable HTTP), as the agent runner uses it: list a server's tools and call
 * one. It only reads: the servers it is pointed at are keyless and read-only (see agent-tools.ts). Answers are data
 * written by other people, capped in size, never instructions.
 */
type FetchLike = typeof fetch;

export type McpTool = { name: string; description?: string; inputSchema?: unknown };

const MAX_ANSWER_BYTES = 400_000;

/** One JSON-RPC answer from a JSON body or an event stream (the last `data:` message with a result or error). */
export function parseMcpAnswer(text: string): { result?: unknown; error?: { message?: string } } {
  const t = text.trimStart();
  if (t.startsWith("{")) return JSON.parse(t);
  let last: { result?: unknown; error?: { message?: string } } | null = null;
  let buf = "";
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) buf += line.slice(5).trim();
    else if (line.trim() === "" && buf) {
      try {
        const m = JSON.parse(buf);
        if (m && (m.result !== undefined || m.error !== undefined)) last = m;
      } catch {
        /* not a JSON message */
      }
      buf = "";
    }
  }
  if (buf) {
    try {
      const m = JSON.parse(buf);
      if (m && (m.result !== undefined || m.error !== undefined)) last = m;
    } catch {
      /* not a JSON message */
    }
  }
  if (!last) throw new Error("no answer");
  return last;
}

export function mcpClient(url: string, opts: { headers?: Record<string, string>; fetchImpl?: FetchLike; timeoutMs?: number } = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let session: string | null = null;
  let started: Promise<void> | null = null;
  let id = 0;

  async function post(body: unknown, expectAnswer = true) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(opts.headers ?? {})
    };
    if (session) headers["mcp-session-id"] = session;
    const r = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000), cache: "no-store", redirect: "error" });
    const sid = r.headers.get("mcp-session-id");
    if (sid && /^[\x21-\x7e]{1,200}$/.test(sid)) session = sid;
    if (!expectAnswer) return null;
    const text = await r.text();
    if (text.length > MAX_ANSWER_BYTES) throw new Error("answer too large");
    if (!r.ok && !text.trim()) throw new Error(`HTTP ${r.status}`);
    const m = parseMcpAnswer(text);
    if (m.error) throw new Error(String(m.error.message ?? "error").slice(0, 160));
    return m.result;
  }

  function start() {
    started ??= (async () => {
      await post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nomad-agents", version: "1" } } });
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, false).catch(() => null);
    })().catch((e) => {
      started = null;
      throw e;
    });
    return started;
  }

  return {
    async listTools(): Promise<McpTool[]> {
      await start();
      const r = (await post({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} })) as { tools?: McpTool[] } | undefined;
      return (r?.tools ?? []).filter((t) => t && typeof t.name === "string");
    },
    /** A tool's answer as text: its structured content as JSON, or its text parts. Throws on a tool error. */
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      await start();
      const r = (await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })) as
        | { structuredContent?: unknown; isError?: boolean; content?: { type?: string; text?: string }[] }
        | undefined;
      const text = (r?.content ?? []).filter((c) => c.type === "text" || typeof c.text === "string").map((c) => c.text ?? "").join("\n");
      if (!r || r.isError) throw new Error((text || "the tool failed").slice(0, 200));
      return r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : text;
    }
  };
}
