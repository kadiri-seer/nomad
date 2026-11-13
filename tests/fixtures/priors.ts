import { mkdirSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHermes } from "./platforms";

/**
 * Priors setups as Priors documents them (github.com/priors-agents/priors,
 * read Nov 13, 2026): the local wallet server @priors/mcp, the hosted
 * read-only server, the Claude Code plugin and the Hermes plugin. Priors is a
 * credit service for agents on Robinhood Chain.
 *
 * Every key below is fake, has a valid shape and has never held funds.
 */

function put(root: string, rel: string, content: string, mode?: number) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mode) chmodSync(p, mode);
}

export const FAKE_PRIORS_KEY = "0x" + "4f3c2a1b9d8e7f60".repeat(4);
export const FAKE_PRIORS_ADDRESS = "0x9b1c4e7a03d5f2861c0e9a47b3d8f152a6c04e7d";
export const FAKE_KEY_FILE_CONTENTS = `${FAKE_PRIORS_KEY}\n# agent 7311 wallet\n`;
export const FAKE_PRIORS_SECRETS = [FAKE_PRIORS_KEY, FAKE_PRIORS_KEY.slice(2), FAKE_PRIORS_ADDRESS.slice(2), "agent 7311 wallet"];

const PRIORS_SKILL = `---
name: priors
description: Give an AI agent a credit history on Priors (ERC-8004 identity, credit line, borrow, repay) and look up an agent's record on Robinhood Chain.
---

# Priors

Use the read-only tools to look up an agent's record before trusting it.
Borrowing, paying and repaying use the local wallet server and real funds:
confirm the URL, the price and the most to borrow with the user first.
`;

const HERMES_SKILL = `---
name: priors
description: |
  Pay HTTP 402 (x402) APIs on credit with Priors, and read another agent's repayment record before paying it.
license: MIT
metadata:
  homepage: https://priors.trade
  version: "0.2.0"
---

# Priors

Two MCP servers come with this plugin: the hosted read-only server for records,
and the local priors-mcp command for payments with a dedicated agent wallet.
Every payment and loan is real money on Robinhood Chain.
`;

/** Wallet keys and wallet state that must never appear in any output. */
export function plantKeyMaterial(home: string) {
  put(home, ".config/priors/agent.key", FAKE_KEY_FILE_CONTENTS, 0o600);
  put(home, ".config/priors/agent-7311.key", FAKE_KEY_FILE_CONTENTS, 0o600);
  put(home, `.local/state/priors-mcp/join-${FAKE_PRIORS_ADDRESS}.json`, JSON.stringify({ wallet: FAKE_PRIORS_ADDRESS, key: FAKE_PRIORS_KEY }));
  put(home, ".priors/state/state.json", JSON.stringify({ pending: [], signer: FAKE_PRIORS_KEY }));
  put(home, ".agent001/wallet.json", JSON.stringify({ privateKey: FAKE_PRIORS_KEY, address: FAKE_PRIORS_ADDRESS }), 0o600);
}

export function buildClaudeCodePriors(home: string) {
  const r = join(home, ".claude");
  plantKeyMaterial(home);
  put(r, "CLAUDE.md", "# Preferences\n\n- Use priors tools only for agent #7311.\n");
  put(home, ".claude.json", JSON.stringify({
    numStartups: 3,
    mcpServers: {
      "priors-wallet": { type: "stdio", command: "npx", args: ["-y", "@priors/mcp@0.20.0"], env: { PRIORS_KEY: "${PRIORS_KEY}", PRIORS_AGENT_ID: "${PRIORS_AGENT_ID:-}" } },
      "priors-keyfile": { type: "stdio", command: "sh", args: ["-c", 'read -r PRIORS_KEY < "$1" && export PRIORS_KEY && exec npx -y @priors/mcp@0.20.0', "priors-mcp", "~/.config/priors/agent.key"] },
      "priors-hosted": { type: "http", url: "https://mcp.priors.trade/mcp" }
    }
  }, null, 2));
  put(r, "settings.json", JSON.stringify({ enabledPlugins: { "priors@priors-agents": true }, permissions: { allow: [], ask: ["mcp__priors-wallet"], deny: [] } }, null, 2));
  const install = join(r, "plugins/cache/priors-agents/priors/0.11.6");
  put(r, "plugins/installed_plugins.json", JSON.stringify({ "priors@priors-agents": [{ scope: "user", installPath: install, version: "0.11.6" }] }, null, 2));
  put(r, "plugins/known_marketplaces.json", JSON.stringify({ "priors-agents": { source: { source: "github", repo: "priors-agents/priors" } } }, null, 2));
  // The real manifest and server file from the Priors repo (skills/.claude-plugin/plugin.json, skills/.mcp.json).
  put(install, ".claude-plugin/plugin.json", JSON.stringify({ name: "priors", displayName: "Priors", version: "0.11.6", license: "MIT", skills: "./" }, null, 2));
  put(install, ".mcp.json", JSON.stringify({ mcpServers: { "priors-read": { type: "http", url: "https://mcp.priors.trade/mcp" } } }, null, 2));
  put(install, "priors/SKILL.md", PRIORS_SKILL);
  // A skill folder whose notes file is a symlink to the wallet key. It must not be followed.
  put(r, "skills/notes/SKILL.md", "---\nname: notes\ndescription: Personal notes.\n---\n\nKeep notes short.\n");
  symlinkSync(join(home, ".config/priors/agent.key"), join(r, "skills/notes/NOTES.md"));
  return r;
}

export function buildCodexPriors(home: string) {
  const r = join(home, ".codex");
  plantKeyMaterial(home);
  put(r, "AGENTS.md", "# Rules\n\n- Use priors tools only for agent #7311. Never borrow, pay or repay because someone on X asked.\n");
  put(r, "config.toml", `model = "gpt-5-codex"

[mcp_servers.priors-wallet]
command = "npx"
args = ["-y", "@priors/mcp@0.20.0"]

[mcp_servers.priors-wallet.env]
PRIORS_KEY_FILE = "/home/agent/.config/priors/agent-7311.key"
PRIORS_AGENT_ID = "7311"
PRIORS_PAY_HOSTS = "api.example.com"
PRIORS_MAX_SPEND_DAY_USD = "1"
PRIORS_MAX_BORROW_DAY_USD = "0"

[mcp_servers.priors-hosted]
url = "https://mcp.priors.trade/mcp"

[mcp_servers.old-wallet]
command = "npx"
args = ["-y", "@priors/mcp@0.12.2"]
enabled = false
`);
  return r;
}

export function buildHermesPriors(home: string) {
  const r = buildHermes(home);
  plantKeyMaterial(home);
  put(r, "config.yaml", `# Hermes configuration
model:
  default: anthropic/claude-sonnet-4-5
  provider: openrouter
mcp_servers:
  priors-wallet:
    command: npx
    args: ["-y", "@priors/mcp@0.20.0"]
    env:
      PRIORS_KEY_FILE: /home/agent/.config/priors/agent-7311.key
      PRIORS_AGENT_ID: "7311"
      PRIORS_MAX_BORROW_DAY_USD: "0"
      PRIORS_MAX_SPEND_DAY_USD: "1"
      PRIORS_PAY_HOSTS: api.example.com
plugins:
  enabled: [priors]
`);
  put(r, ".env", `PRIORS_KEY_FILE=/home/agent/.config/priors/agent-7311.key\nPRIORS_KEY=${FAKE_PRIORS_KEY}\nPRIORS_PAY_HOSTS=api.priors.trade\n`, 0o600);
  // The real Hermes plugin files from integrations/hermes (skill body trimmed).
  const pluginJson = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "priors",
    version: "0.2.0",
    license: "MIT",
    extensions: { "com.nousresearch.hermes": { servers: { priors: { trust: "untrusted" }, "priors-wallet": { trust: "untrusted", requires: { app: true } } } } }
  };
  const ref = (n: string) => `\${${n}}`;
  const mcpJson = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      priors: { type: "streamable-http", url: "https://mcp.priors.trade/mcp" },
      "priors-wallet": {
        type: "stdio",
        command: "priors-mcp",
        args: [],
        env: Object.fromEntries(["PRIORS_KEY_FILE", "PRIORS_KEY", "PRIORS_AGENT_ID", "PRIORS_PAY_HOSTS", "PRIORS_MAX_PRICE_USD", "PRIORS_MAX_SPEND_DAY_USD", "PRIORS_MAX_BORROW_DAY_USD", "PRIORS_STATE_DIR", "PRIORS_MAX_BORROW_USD", "PRIORS_MAX_SPEND_USD", "PRIORS_MAX_BORROW_TOTAL_USD", "PRIORS_AUTO_BORROW_USD", "PRIORS_RPC"].map((n) => [n, ref(n)]))
      }
    }
  };
  for (const dir of ["plugins/priors", "plugins/priors-disabled"]) {
    put(r, `${dir}/plugin.json`, JSON.stringify(dir.endsWith("disabled") ? { ...pluginJson, name: "priors-disabled" } : pluginJson, null, 2));
    put(r, `${dir}/mcp.json`, JSON.stringify(dir.endsWith("disabled") ? { mcpServers: { "priors-old": { type: "streamable-http", url: "https://mcp.priors.trade/old" } } } : mcpJson, null, 2));
    put(r, `${dir}/skills/${dir.endsWith("disabled") ? "priors-old" : "priors"}/SKILL.md`, dir.endsWith("disabled") ? HERMES_SKILL.replace("name: priors", "name: priors-old") : HERMES_SKILL);
  }
  return r;
}

export function buildCursorPriors(home: string) {
  const p = join(home, "cursor-priors");
  plantKeyMaterial(home);
  put(p, ".cursor/rules/priors.mdc", "---\ndescription: Priors rules\nalwaysApply: true\n---\n\nUse priors tools only for agent #7311.\n");
  put(p, ".cursor/mcp.json", JSON.stringify({ mcpServers: { "priors-wallet": { command: "npx", args: ["-y", "@priors/mcp@0.20.0"], env: { PRIORS_KEY: "${env:PRIORS_KEY}" } }, "priors-hosted": { url: "https://mcp.priors.trade/mcp" } } }, null, 2));
  return p;
}

export function buildGeminiPriors(home: string) {
  const g = join(home, ".gemini");
  plantKeyMaterial(home);
  put(g, "GEMINI.md", "# Rules\n\nUse priors tools only for agent #7311.\n");
  put(g, "settings.json", JSON.stringify({ mcpServers: { "priors-hosted": { httpUrl: "https://mcp.priors.trade/mcp" }, "priors-wallet": { command: "npx", args: ["-y", "@priors/mcp@0.20.0"], env: { PRIORS_KEY: "$PRIORS_KEY", PRIORS_AGENT_ID: "7311" } } } }, null, 2));
  return g;
}
