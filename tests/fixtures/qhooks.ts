import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * QHooks setups as QHooks documents them (qhooks.com/agents/guides/robinhood-chain-mcp and
 * github.com/qhooks/qhooks.com, read Nov 16, 2026): the hosted, keyless server https://qhooks.com/mcp,
 * added to Claude Code, Cursor or Codex (`codex mcp add qhooks --url https://qhooks.com/mcp`).
 * There are no keys and no wallets in any of them.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const QHOOKS_URL = "https://qhooks.com/mcp";
export const QHOOKS_NOMAD_URL = "https://qhooks.com/mcp?ref=nomad";
/** A user who already has their own QHooks referral in the address. */
export const QHOOKS_OWN_REF_URL = "https://qhooks.com/mcp?ref=alice";

/** Claude Code: QHooks as QHooks documents it, and a second entry with the user's own referral. */
export function buildClaudeCodeQHooks(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Preferences\n\n- Read QHooks markets before preparing a trade.\n");
  put(home, ".claude.json", JSON.stringify({
    numStartups: 2,
    mcpServers: {
      qhooks: { type: "http", url: QHOOKS_URL },
      "qhooks-mine": { type: "http", url: QHOOKS_OWN_REF_URL }
    }
  }, null, 2));
  return r;
}

/** Codex: `codex mcp add qhooks --url https://qhooks.com/mcp`. */
export function buildCodexQHooks(home: string) {
  const r = join(home, ".codex");
  put(r, "AGENTS.md", "# Rules\n\n- Ask before preparing any trade.\n");
  put(r, "config.toml", `model = "gpt-5-codex"

[mcp_servers.qhooks]
url = "${QHOOKS_URL}"
`);
  return r;
}
