import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Bull setups as Bull documents them (bull.family/llms.txt and /developers, read Nov 26, 2026): the hosted server
 * added with `claude mcp add --transport http bull https://www.bull.family/api/mcp`, and the local server run as
 * `BULL_AGENT_KEY=0x... node bull-mcp.mjs`, here from a pinned copy. The key is made up.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const BULL_URL = "https://www.bull.family/api/mcp";
export const FAKE_BULL_KEY = "0x8f2c1b7e4d9a3f6c0b5e8d2a7f1c4b9e3d6a0f5c8b2e7d1a4f9c3b6e0d5a8f2c";

/** Claude Code: Bull's hosted server, and its local server with the agent's key. */
export function buildClaudeCodeBull(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Preferences\n\n- Check a counterparty's Bull record before any deal over 50 USDG.\n");
  put(
    home,
    ".claude.json",
    JSON.stringify(
      {
        mcpServers: {
          bull: { type: "http", url: BULL_URL },
          "bull-local": { command: "node", args: ["/home/me/bull/bull-mcp.mjs"], env: { BULL_AGENT_KEY: FAKE_BULL_KEY } }
        }
      },
      null,
      2
    )
  );
  return r;
}
