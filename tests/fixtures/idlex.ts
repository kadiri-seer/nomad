import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Idlex setups as Idlex documents them (idlex-mcp 0.1.0 README and idlex.network/agents, read Nov 23, 2026): the
 * local server `node /path/to/idlex-mcp/src/server.ts`, with IDLEX_AGENT_KEY (the agent wallet's key) and the spend
 * caps IDLEX_MAX_JOB_USDG and IDLEX_BUDGET_USDG. Every key below is fake.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const FAKE_IDLEX_KEY = "0x" + "6c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d";

/** Claude Code, as `claude mcp add idlex -e IDLEX_AGENT_KEY=… -- node …/src/server.ts` writes it, with both caps set. */
export function buildClaudeCodeIdlex(home: string, { caps = true }: { caps?: boolean } = {}) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Rules\n\n- Run summaries on Idlex, cheapest node.\n");
  const env: Record<string, string> = { IDLEX_AGENT_KEY: FAKE_IDLEX_KEY };
  if (caps) Object.assign(env, { IDLEX_MAX_JOB_USDG: "0.01", IDLEX_BUDGET_USDG: "0.10" });
  put(home, ".claude.json", JSON.stringify({ numStartups: 2, mcpServers: { idlex: { type: "stdio", command: "node", args: [join(home, "idlex-mcp", "src", "server.ts")], env } } }, null, 2));
  return r;
}
