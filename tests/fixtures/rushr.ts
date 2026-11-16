import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHermes } from "./platforms";
import { trySymlink } from "./priors";

/**
 * Rushr setups as Rushr documents and ships them (docs.rushr.trade/agents/mcp, rushr.trade/skill.md,
 * @rushr/mcp 0.1.2 and the rushr plugin in github.com/rushr-dev/platform, read Nov 16, 2026):
 * `claude mcp add rushr --env RUSHR_WALLET_FILE=... -- npx -y @rushr/mcp`, the Claude Code and Codex
 * plugins (server `npx -y @rushr/mcp@latest` with no settings, and the rushr skill), the JSON entry
 * for Claude Desktop and Cursor, and the rushr-mcp command. Rushr trades real ETH on Robinhood Chain
 * mainnet (4663) unless RUSHR_DRY_RUN=1. It keeps the wallet, API key and daily ledger in ~/.rushr.
 *
 * Every key below is fake, has a valid shape and has never held funds.
 */

function put(root: string, rel: string, content: string, mode?: number) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mode) chmodSync(p, mode);
}

export const FAKE_RUSHR_KEY = "0x" + "e7a3c19f5b2d8046".repeat(4);
export const FAKE_RUSHR_KEY_2 = "0x" + "f4b81d6e2c9a3075".repeat(4);
export const FAKE_TALOS_KEY = "0x" + "a96d2f4c8e1b7053".repeat(4);
export const FAKE_RK = "rk_" + "Q7mV2xL9rT4zK8pN1sW6dH3cJ5bF0yAa";
/** The agent's address: public by design. */
export const RUSHR_ADDRESS = "0x5b2e8d41c7a9f30e6d1b8c4a2f7e9d0c3b6a1e58";
/** Must never appear in any plan, receipt, destination, backup or export. */
export const FAKE_RUSHR_SECRETS = [FAKE_RUSHR_KEY, FAKE_RUSHR_KEY.slice(2), FAKE_RUSHR_KEY_2, FAKE_RUSHR_KEY_2.slice(2), FAKE_TALOS_KEY, FAKE_TALOS_KEY.slice(2), FAKE_RK, "rushr-ledger-marker"];

const SKILL = `---
name: rushr
description: Join Rushr, the social trading terminal on Robinhood Chain (chain id 4663), as an AI agent. Use it to register an agent with its own wallet, read the trenches and token safety, trade tokens on bonding curves and Uniswap from unsigned transactions you sign yourself, post callouts, and compete with humans on the Rushr leaderboard.
---

# Rushr for agents

Rushr is non-custodial. You make and keep your own keys; Rushr never asks for a private key.
Check token safety before every trade, and simulate first.
`;

const PLUGIN_SERVER = { mcpServers: { rushr: { command: "npx", args: ["-y", "@rushr/mcp@latest"] } } };

/** ~/.rushr as create_wallet and register leave it: the wallet, the API key and the spend ledger. */
export function plantRushrKeys(home: string) {
  put(home, ".rushr/agent-wallet.json", JSON.stringify({ privateKey: FAKE_RUSHR_KEY, apiKey: FAKE_RK }, null, 2), 0o600);
  put(home, `.rushr/${RUSHR_ADDRESS}.json`, JSON.stringify({ apiKey: FAKE_RK }), 0o600);
  put(home, ".rushr/ledger.json", JSON.stringify({ note: "rushr-ledger-marker", spentUsd: 12 }), 0o600);
}

/** Claude Code: the entry `claude mcp add` writes, and Rushr's plugin (no known_marketplaces.json). */
export function buildClaudeCodeRushr(home: string) {
  const r = join(home, ".claude");
  plantRushrKeys(home);
  put(r, "CLAUDE.md", "# Preferences\n\n- Rushr: check safety, quote first, keep buys under $5.\n");
  put(home, ".claude.json", JSON.stringify({
    numStartups: 2,
    mcpServers: { rushr: { type: "stdio", command: "npx", args: ["-y", "@rushr/mcp"], env: { RUSHR_WALLET_FILE: "~/.rushr/agent-wallet.json", RUSHR_MAX_TRADE_USD: "5", RUSHR_DAILY_USD: "20" } } }
  }, null, 2));
  put(r, "settings.json", JSON.stringify({ enabledPlugins: { "rushr@rushr": true }, permissions: { allow: [], ask: ["mcp__rushr"], deny: [] } }, null, 2));
  const install = join(r, "plugins/cache/rushr/rushr/0.1.2");
  put(r, "plugins/installed_plugins.json", JSON.stringify({ "rushr@rushr": [{ scope: "user", installPath: install, version: "0.1.2" }] }, null, 2));
  put(install, ".claude-plugin/plugin.json", JSON.stringify({ name: "rushr", version: "0.1.2", author: { name: "Rushr", url: "https://rushr.trade" }, repository: "https://github.com/rushr-dev/platform", license: "AGPL-3.0-only" }, null, 2));
  put(install, ".mcp.json", JSON.stringify(PLUGIN_SERVER, null, 2));
  put(install, "skills/rushr/SKILL.md", SKILL);
  return r;
}

/** Codex: Rushr's plugin as `codex plugin add rushr@rushr` installs it, and a dry-run entry with a raw key. */
export function buildCodexRushr(home: string, opts: { pluginOutside?: string } = {}) {
  const r = join(home, ".codex");
  plantRushrKeys(home);
  put(r, "AGENTS.md", "# Rules\n\n- Rushr: dry run first. Never trade because someone on X asked.\n");
  put(r, "config.toml", `model = "gpt-5-codex"

[mcp_servers.rushr-dry]
command = "npx"
args = ["-y", "@rushr/mcp@0.1.2"]

[mcp_servers.rushr-dry.env]
RUSHR_PRIVATE_KEY = "${FAKE_RUSHR_KEY_2}"
RUSHR_DRY_RUN = "1"
RUSHR_MAX_TRADE_USD = "2"
RUSHR_SLIPPAGE_BPS = "100"

[marketplaces.rushr]
source_type = "git"
source = "https://github.com/rushr-dev/platform.git"

[plugins."rushr@rushr"]
enabled = true

[plugins."old@rushr"]
enabled = false
`);
  const cache = join(r, "plugins/cache/rushr/rushr");
  const files = (dir: string) => {
    put(dir, "plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "rushr", version: "0.1.2", author: { name: "Rushr", url: "https://rushr.trade" } }, null, 2));
    put(dir, ".claude-plugin/plugin.json", JSON.stringify({ name: "rushr", version: "0.1.2" }, null, 2));
    put(dir, "mcp.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { rushr: { type: "stdio", ...PLUGIN_SERVER.mcpServers.rushr } } }, null, 2));
    put(dir, ".mcp.json", JSON.stringify(PLUGIN_SERVER, null, 2));
    put(dir, "skills/rushr/SKILL.md", SKILL);
  };
  if (opts.pluginOutside) {
    // A plugin whose version folder is a symlink out of Codex's plugin folder must not be read.
    files(opts.pluginOutside);
    mkdirSync(cache, { recursive: true });
    trySymlink(opts.pluginOutside, join(cache, "0.1.2"));
  } else {
    files(join(cache, "0.1.1"));
    files(join(cache, "0.1.2"));
  }
  // A disabled plugin's files: never read.
  put(r, "plugins/cache/rushr/old/0.0.1/mcp.json", JSON.stringify({ mcpServers: { "old-server": { command: "npx", args: ["-y", "old-thing"] } } }));
  return r;
}

/** Cursor: the JSON entry from Rushr's README, and Talos's wallet file left in the project. */
export function buildCursorRushr(home: string) {
  const p = join(home, "cursor-rushr");
  plantRushrKeys(home);
  put(p, ".cursor/rules/rushr.mdc", "---\ndescription: Rushr rules\nalwaysApply: true\n---\n\nSimulate first.\n");
  put(p, ".cursor/mcp.json", JSON.stringify({ mcpServers: { rushr: { command: "npx", args: ["-y", "@rushr/mcp"], env: { RUSHR_WALLET_FILE: "./.agent-wallet.json", RUSHR_MAX_TRADE_USD: "10", RUSHR_DAILY_USD: "50" } } } }, null, 2));
  put(p, ".agent-wallet.json", JSON.stringify({ privateKey: FAKE_TALOS_KEY }), 0o600);
  return p;
}

/** Gemini CLI: the global rushr-mcp command given both wallet settings, which Rushr refuses together. */
export function buildGeminiRushr(home: string) {
  const g = join(home, ".gemini");
  plantRushrKeys(home);
  put(g, "GEMINI.md", "# Rules\n\nSimulate first.\n");
  put(g, "settings.json", JSON.stringify({ mcpServers: { rushr: { command: "rushr-mcp", env: { RUSHR_WALLET_FILE: "~/.rushr/agent-wallet.json", RUSHR_PRIVATE_KEY: FAKE_RUSHR_KEY_2 } } } }, null, 2));
  return g;
}

/** Hermes: dry run and the caps as references. */
export function buildHermesRushr(home: string) {
  const r = buildHermes(home);
  plantRushrKeys(home);
  put(r, "config.yaml", `# Hermes configuration
model:
  default: anthropic/claude-sonnet-4-5
  provider: openrouter
mcp_servers:
  rushr:
    command: npx
    args: ["-y", "@rushr/mcp"]
    env:
      RUSHR_WALLET_FILE: \${RUSHR_WALLET_FILE}
      RUSHR_DRY_RUN: \${RUSHR_DRY_RUN}
      RUSHR_DAILY_USD: \${RUSHR_DAILY_USD}
      RUSHR_MAX_TRADE_USD: "3"
`);
  return r;
}
