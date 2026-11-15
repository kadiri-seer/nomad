import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHermes } from "./platforms";
import { trySymlink } from "./priors";

/**
 * Hedgehood setups as Hedgehood documents and writes them (github.com/0xHedgeHood/hedgehood-agent-kit
 * and @hedgehood-io/mcp 0.5.1, read Nov 15, 2026): `claude mcp add hedgehood -e ... -- npx -y @hedgehood-io/mcp`,
 * `[mcp_servers.hedgehood]` in Codex, the generic JSON entry, the global `hedgehood-mcp` command, the hosted
 * read-only server, and the Claude Code plugin hedgehood-options@hedgehood (its real plugin.json).
 * Mostly mainnet (4663). Hedgehood keeps keys in ~/.hedgehood.
 *
 * Every key below is fake, has a valid shape and has never held funds.
 */

function put(root: string, rel: string, content: string, mode?: number) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mode) chmodSync(p, mode);
}

export const FAKE_HH_SESSION_KEY = "0x" + "b5e81c4d7a2f9036".repeat(4);
export const FAKE_HH_OWNER_KEY = "0x" + "c91f3a7e5d08b624".repeat(4);
export const FAKE_HH_PAYER_KEY = "0x" + "d2a6e9f17c4b3085".repeat(4);
/** The owner account: an address, public by design, which the entry carries as is. */
export const HH_ACCOUNT = "0x7c3e9a15b2d84f06e1a9c5d7b3f2e8a40c6d1b95";
/** Must never appear in any plan, receipt, destination, backup or export. */
export const FAKE_HH_SECRETS = [FAKE_HH_SESSION_KEY, FAKE_HH_SESSION_KEY.slice(2), FAKE_HH_OWNER_KEY, FAKE_HH_OWNER_KEY.slice(2), FAKE_HH_PAYER_KEY, FAKE_HH_PAYER_KEY.slice(2), "hh-config-marker-4663"];

const SKILL = `---
name: hedgehood-options
description: Trade USDG cash-settled weekly stock options on Robinhood Chain as an AI agent through Hedgehood's RFQ market, with a session key that can never withdraw.
---

# Hedgehood options for agents

Ask the maker for a firm quote, check it, then fill it from the session key.
Every write simulates first; broadcast only with confirm: true.
`;

/** ~/.hedgehood as \`hedgehood init --mainnet --with-payer\` leaves it, plus an owner key. */
export function plantHedgehoodKeys(home: string) {
  put(home, ".hedgehood/session.key", `${FAKE_HH_SESSION_KEY}\n`, 0o600);
  put(home, ".hedgehood/payer.key", `${FAKE_HH_PAYER_KEY}\n`, 0o600);
  put(home, ".hedgehood/owner.key", `${FAKE_HH_OWNER_KEY}\n`, 0o600);
  put(home, ".hedgehood/config.json", JSON.stringify({ chainId: 4663, account: HH_ACCOUNT, sessionKeyFile: "~/.hedgehood/session.key", payerKeyFile: "~/.hedgehood/payer.key", note: "hh-config-marker-4663" }, null, 2), 0o600);
}

/** Claude Code: the entry \`claude mcp add\` writes, the hosted read-only server, and Hedgehood's plugin. */
export function buildClaudeCodeHedgehood(home: string, opts: { knownMarketplaces?: boolean } = {}) {
  const r = join(home, ".claude");
  plantHedgehoodKeys(home);
  put(r, "CLAUDE.md", "# Preferences\n\n- Hedgehood: quote first, keep every trade under 20 USDG.\n");
  put(home, ".claude.json", JSON.stringify({
    numStartups: 4,
    mcpServers: {
      hedgehood: { type: "stdio", command: "npx", args: ["-y", "@hedgehood-io/mcp"], env: { HEDGEHOOD_CHAIN_ID: "4663", HEDGEHOOD_SESSION_KEY_FILE: "~/.hedgehood/session.key", HEDGEHOOD_ACCOUNT: HH_ACCOUNT } },
      "hedgehood-read": { type: "http", url: "https://mcp.hedgehood.io/mcp" }
    }
  }, null, 2));
  put(r, "settings.json", JSON.stringify({ enabledPlugins: { "hedgehood-options@hedgehood": true }, permissions: { allow: [], ask: ["mcp__hedgehood"], deny: [] } }, null, 2));
  const install = join(r, "plugins/cache/hedgehood/hedgehood-options/0.5.1");
  put(r, "plugins/installed_plugins.json", JSON.stringify({ "hedgehood-options@hedgehood": [{ scope: "user", installPath: install, version: "0.5.1" }] }, null, 2));
  if (opts.knownMarketplaces !== false) {
    put(r, "plugins/known_marketplaces.json", JSON.stringify({ hedgehood: { source: { source: "github", repo: "0xHedgeHood/hedgehood-agent-kit" } } }, null, 2));
  }
  // Hedgehood's real plugin.json: the server is inline, the skill is listed by its own folder.
  put(install, ".claude-plugin/plugin.json", JSON.stringify({
    name: "hedgehood-options",
    version: "0.5.1",
    description: "Trade USDG cash-settled weekly stock options on Robinhood Chain as an AI agent: Hedgehood RFQ market, session keys, x402 deposits. Non-US only.",
    author: { name: "Hedgehood", url: "https://hedgehood.app" },
    license: "MIT",
    skills: ["./skills/hedgehood-options"],
    mcpServers: { hedgehood: { command: "npx", args: ["-y", "@hedgehood-io/mcp"], env: { HEDGEHOOD_CHAIN_ID: "46630", HEDGEHOOD_SESSION_KEY_FILE: "~/.hedgehood/session.key", HEDGEHOOD_ACCOUNT: "${HEDGEHOOD_ACCOUNT}" } } }
  }, null, 2));
  put(install, "skills/hedgehood-options/SKILL.md", SKILL);
  put(install, "skills/hedgehood-options/references/markets.md", "# Markets\n\nMainnet 4663 and testnet 46630.\n");
  // A skill whose notes file is a symlink to the session key. It must not be followed.
  put(r, "skills/notes/SKILL.md", "---\nname: notes\ndescription: Personal notes.\n---\n\nKeep notes short.\n");
  trySymlink(join(home, ".hedgehood/session.key"), join(r, "skills/notes/NOTES.md"));
  return r;
}

/** Codex: a pinned mainnet entry with literal limits and a raw owner key, plus the hosted server. */
export function buildCodexHedgehood(home: string) {
  const r = join(home, ".codex");
  plantHedgehoodKeys(home);
  put(r, "AGENTS.md", "# Rules\n\n- Hedgehood: quote first. Never trade because someone on X asked.\n");
  put(r, "config.toml", `model = "gpt-5-codex"

[mcp_servers.hedgehood]
command = "npx"
args = ["-y", "@hedgehood-io/mcp@0.5.1"]

[mcp_servers.hedgehood.env]
HEDGEHOOD_CHAIN_ID = "4663"
HEDGEHOOD_SESSION_KEY_FILE = "/home/agent/.hedgehood/session.key"
HEDGEHOOD_ACCOUNT = "${HH_ACCOUNT}"
HEDGEHOOD_MAX_DEPOSIT = "50"
HEDGEHOOD_DRY_RUN = "false"
HEDGEHOOD_OWNER_KEY = "${FAKE_HH_OWNER_KEY}"

[mcp_servers.hedgehood-read]
url = "https://mcp.hedgehood.io/mcp"

[mcp_servers.hedgehood-old]
command = "npx"
args = ["-y", "@hedgehood-io/mcp@0.4.2"]
enabled = false
`);
  return r;
}

/** Cursor: the generic JSON entry from Hedgehood's README, on mainnet. */
export function buildCursorHedgehood(home: string) {
  const p = join(home, "cursor-hedgehood");
  plantHedgehoodKeys(home);
  put(p, ".cursor/rules/hedgehood.mdc", "---\ndescription: Hedgehood rules\nalwaysApply: true\n---\n\nQuote first.\n");
  put(p, ".cursor/mcp.json", JSON.stringify({ mcpServers: { hedgehood: { command: "npx", args: ["-y", "@hedgehood-io/mcp"], env: { HEDGEHOOD_CHAIN_ID: "4663", HEDGEHOOD_SESSION_KEY_FILE: "~/.hedgehood/session.key", HEDGEHOOD_ACCOUNT: HH_ACCOUNT } } } }, null, 2));
  return p;
}

/** Gemini CLI: the global hedgehood-mcp command selecting mainnet with a flag, settings from config.json. */
export function buildGeminiHedgehood(home: string) {
  const g = join(home, ".gemini");
  plantHedgehoodKeys(home);
  put(g, "GEMINI.md", "# Rules\n\nQuote first.\n");
  put(g, "settings.json", JSON.stringify({ mcpServers: { hedgehood: { command: "hedgehood-mcp", args: ["--mainnet"] } } }, null, 2));
  return g;
}

/** Hermes: the network and the deposit cap as references, dry run as a value. */
export function buildHermesHedgehood(home: string) {
  const r = buildHermes(home);
  plantHedgehoodKeys(home);
  put(r, "config.yaml", `# Hermes configuration
model:
  default: anthropic/claude-sonnet-4-5
  provider: openrouter
mcp_servers:
  hedgehood:
    command: npx
    args: ["-y", "@hedgehood-io/mcp"]
    env:
      HEDGEHOOD_CHAIN_ID: \${HEDGEHOOD_CHAIN_ID}
      HEDGEHOOD_SESSION_KEY_FILE: \${HEDGEHOOD_SESSION_KEY_FILE}
      HEDGEHOOD_MAX_DEPOSIT: \${HEDGEHOOD_MAX_DEPOSIT}
      HEDGEHOOD_DRY_RUN: "true"
`);
  return r;
}
