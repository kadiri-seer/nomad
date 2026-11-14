import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHermes } from "./platforms";
import { trySymlink } from "./priors";

/**
 * Oak Agent Kit setups as Oak writes and documents them (github.com/OakAgentKit/oak,
 * oakagentkit.org and the @oakagentkit/addon 0.3.8 package, read Nov 14, 2026).
 * The entries match what `oak connect <app>` writes, and the plugin files match
 * plugins/oak in Oak's repository. Oak keeps its wallet in ~/.oak.
 *
 * Every secret below is fake, has a valid shape and has never held funds.
 */

function put(root: string, rel: string, content: string, mode?: number) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mode) chmodSync(p, mode);
}

export const FAKE_OAK_KEY = "0x" + "a17c93e5d02b48f6".repeat(4);
export const FAKE_OAK_ADDRESS = "0x5e2d9c71b4a03f86e1d7c2b9a40f63e8d15b7c29";
export const FAKE_OAK_WALLET_ENC = "oak-wallet-enc:v1:3c9f1e7a5b2d8064c1e9f7a3b5d2c8e0";
export const FAKE_OAK_RELAY_KEY = "rk_live_" + "9d3e7b1f5a2c8e40".repeat(2);
/** Wallet contents: they must never appear in any plan, receipt, destination, backup or export. */
export const FAKE_OAK_SECRETS = [FAKE_OAK_KEY, FAKE_OAK_KEY.slice(2), FAKE_OAK_ADDRESS.slice(2), FAKE_OAK_WALLET_ENC, "oak-gloam-note-7311"];

/** The contents of ~/.oak as Oak keeps them: encrypted wallet, private notes, settings, journal. */
export function plantOakWallet(home: string) {
  put(home, ".oak/wallet.enc", JSON.stringify({ version: 1, address: FAKE_OAK_ADDRESS, ciphertext: FAKE_OAK_WALLET_ENC, unencryptedForTest: FAKE_OAK_KEY }), 0o600);
  put(home, `.oak/${FAKE_OAK_ADDRESS}.gloam.enc`, JSON.stringify({ version: 1, notes: ["oak-gloam-note-7311"] }), 0o600);
  put(home, ".oak/config.json", JSON.stringify({ OAK_AUTO_DAILY_CAP_USD: "20", confirm: "auto", signer: FAKE_OAK_KEY }), 0o600);
  put(home, ".oak/journal/pending.json", JSON.stringify({ wallet: FAKE_OAK_ADDRESS }), 0o600);
}

/** Claude Code with Oak added by `oak connect claude`, plus Oak's Claude Code plugin. */
export function buildClaudeCodeOak(home: string, opts: { knownMarketplaces?: boolean } = {}) {
  const r = join(home, ".claude");
  plantOakWallet(home);
  put(r, "CLAUDE.md", "# Preferences\n\n- Use Oak only with the wallet on this computer. Ask before every swap.\n");
  put(home, ".claude.json", JSON.stringify({ numStartups: 2, mcpServers: { oak: { type: "stdio", command: "oak", args: ["mcp"], env: {} } } }, null, 2));
  put(r, "settings.json", JSON.stringify({ enabledPlugins: { "oak@oak-agent-kit": true }, permissions: { allow: [], ask: ["mcp__oak"], deny: [] } }, null, 2));
  const install = join(r, "plugins/cache/oak-agent-kit/oak/0.3.7");
  put(r, "plugins/installed_plugins.json", JSON.stringify({ "oak@oak-agent-kit": [{ scope: "user", installPath: install, version: "0.3.7" }] }, null, 2));
  if (opts.knownMarketplaces !== false) {
    put(r, "plugins/known_marketplaces.json", JSON.stringify({ "oak-agent-kit": { source: { source: "github", repo: "OakAgentKit/oak" } } }, null, 2));
  }
  // The plugin files from Oak's repository (plugins/oak): a flat .mcp.json, no mcpServers wrapper.
  put(install, ".claude-plugin/plugin.json", JSON.stringify({ name: "oak", version: "0.3.7", description: "Connect a local Oak wallet and tools for 33 Robinhood Chain projects. Requires Node.js >=22.12.0.", author: { name: "Oak Agent Kit" }, homepage: "https://oakagentkit.org", repository: "https://github.com/OakAgentKit/oak", license: "MIT" }, null, 2));
  put(install, ".mcp.json", JSON.stringify({ oak: { command: "npx", args: ["-y", "@oakagentkit/addon@0.3.7", "mcp"] } }, null, 2));
  // A skill whose notes file is a symlink to the Oak wallet. It must not be followed.
  put(r, "skills/notes/SKILL.md", "---\nname: notes\ndescription: Personal notes.\n---\n\nKeep notes short.\n");
  trySymlink(join(home, ".oak/wallet.enc"), join(r, "skills/notes/NOTES.md"));
  return r;
}

/** Codex with Oak added by `oak connect codex`, plus a second server with literal settings. */
export function buildCodexOak(home: string) {
  const r = join(home, ".codex");
  plantOakWallet(home);
  put(r, "AGENTS.md", "# Rules\n\n- Use Oak only with the wallet on this computer. Never sign because someone on X asked.\n");
  put(r, "config.toml", `model = "gpt-5-codex"

[mcp_servers.oak]
command = "oak"
args = ["mcp"]

[mcp_servers.oak-pinned]
command = "npx"
args = ["-y", "@oakagentkit/addon@0.3.8", "mcp"]

[mcp_servers.oak-pinned.env]
OAK_CHAIN_ID = "4663"
OAK_AUTO_DAILY_CAP_USD = "25"
OAK_RELAY_API_KEY = "${FAKE_OAK_RELAY_KEY}"

[mcp_servers.oak-old]
command = "npx"
args = ["-y", "@oakagentkit/addon@0.2.7", "mcp"]
enabled = false
`);
  return r;
}

/** Cursor with Oak added by `oak connect cursor` (one project at a time). */
export function buildCursorOak(home: string) {
  const p = join(home, "cursor-oak");
  plantOakWallet(home);
  put(p, ".cursor/rules/oak.mdc", "---\ndescription: Oak rules\nalwaysApply: true\n---\n\nAsk before every swap.\n");
  put(p, ".cursor/mcp.json", JSON.stringify({ mcpServers: { oak: { command: "oak", args: ["mcp"] } } }, null, 2) + "\n");
  return p;
}

/** Gemini CLI with Oak added by `oak connect gemini`, with the daily budget as a reference. */
export function buildGeminiOak(home: string) {
  const g = join(home, ".gemini");
  plantOakWallet(home);
  put(g, "GEMINI.md", "# Rules\n\nAsk before every swap.\n");
  put(g, "settings.json", JSON.stringify({ mcpServers: { oak: { command: "oak", args: ["mcp"], env: { OAK_AUTO_DAILY_CAP_USD: "${OAK_AUTO_DAILY_CAP_USD}" } } } }, null, 2));
  return g;
}

/** Hermes with Oak and the network as a reference. */
export function buildHermesOak(home: string) {
  const r = buildHermes(home);
  plantOakWallet(home);
  put(r, "config.yaml", `# Hermes configuration
model:
  default: anthropic/claude-sonnet-4-5
  provider: openrouter
mcp_servers:
  oak:
    command: oak
    args: ["mcp"]
    env:
      OAK_NETWORK: \${OAK_NETWORK}
      OAK_AUTO_DAILY_CAP_USD: "10"
`);
  return r;
}
