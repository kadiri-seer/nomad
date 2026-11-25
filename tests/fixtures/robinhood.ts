import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Robinhood setups as Robinhood documents them (robinhood.com/us/en/support/articles/agentic-trading-overview and
 * /agentic-credit-card, read Nov 25, 2026): `claude mcp add robinhood-trading --transport http
 * https://agent.robinhood.com/mcp/trading` and the same for robinhood-banking. Each app signs in itself, so the
 * configuration holds only the addresses; there are no keys in any of them.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const ROBINHOOD_TRADING_URL = "https://agent.robinhood.com/mcp/trading";
export const ROBINHOOD_BANKING_URL = "https://banking-agent.robinhood.com/mcp/banking";

/** Claude Code: Robinhood's two hosted servers and the owner's standing rule. */
export function buildClaudeCodeRobinhood(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Preferences\n\n- Ask me before every trade or purchase.\n");
  put(
    home,
    ".claude.json",
    JSON.stringify({ mcpServers: { "robinhood-trading": { type: "http", url: ROBINHOOD_TRADING_URL }, "robinhood-banking": { type: "http", url: ROBINHOOD_BANKING_URL } } }, null, 2)
  );
  return r;
}
