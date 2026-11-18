import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Stoa setups as Stoa documents them (stoadex.com/docs/mcp and stoadex.com/skills/stoa/SKILL.md, read
 * Nov 18, 2026): `claude mcp add --transport http stoa https://stoadex.com/mcp` and the `stoa` skill.
 * Keyless; there are no keys or wallets in any of them.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const STOA_URL = "https://stoadex.com/mcp";

/** Claude Code: Stoa's hosted server and its skill. */
export function buildClaudeCodeStoa(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Preferences\n\n- Run Stoa's safety check before buying an unfamiliar token.\n");
  put(r, "skills/stoa/SKILL.md", "---\nname: stoa\ndescription: Quote, check and build token swaps on Robinhood Chain and Elysium with Stoa's keyless MCP server.\n---\n\n# Stoa\n\nRun safety_check on unfamiliar tokens, show the quote, then call build_swap. Confirm tx.to is the Stoa router.\n");
  put(home, ".claude.json", JSON.stringify({ mcpServers: { stoa: { type: "http", url: STOA_URL } } }, null, 2));
  return r;
}
