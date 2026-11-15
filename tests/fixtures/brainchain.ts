import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHermes } from "./platforms";
import { trySymlink } from "./priors";

/**
 * BrainChain setups as BrainChain documents them (docs.usebrainchain.com/agents,
 * github.com/usebrainchain/brainchain-mcp and github.com/usebrainchain/brainchain-worker, read Nov 15, 2026):
 * `claude mcp add brainchain -e BRAINCHAIN_PAYER_KEY_FILE=~/.brainchain/payer.key -- npx -y brainchain-mcp@0.9.3`,
 * the repo's mcp.json, `openclaw mcp set brainchain '{...}'` with the skill's example settings, and the two
 * OpenClaw skills (brainchain and brainchain-worker). Mostly mainnet. BrainChain keeps keys in ~/.brainchain.
 *
 * Every key below is fake, has a valid shape and has never held funds.
 */

function put(root: string, rel: string, content: string, mode?: number) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mode) chmodSync(p, mode);
}

export const FAKE_BC_PAYER_KEY = "0x" + "e4c17a9b3f5d2068".repeat(4);
export const FAKE_BC_WORKER_KEY = "0x" + "f38d2b6a1c9e4057".repeat(4);
export const BC_PAYER_ADDRESS = "0x3a9c5e7b1d2f4a6c8e0b2d4f6a8c0e2b4d6f8a1c";
/** Must never appear in any plan, receipt, destination, backup or export. */
export const FAKE_BC_SECRETS = [FAKE_BC_PAYER_KEY, FAKE_BC_PAYER_KEY.slice(2), FAKE_BC_WORKER_KEY, FAKE_BC_WORKER_KEY.slice(2), "bc-spend-marker-4663", "bc-worker-state-marker"];

/** ~/.brainchain as the docs' setup leaves it, the daily spending record, and the worker's state. */
export function plantBrainChainKeys(home: string) {
  put(home, ".brainchain/payer.key", `${FAKE_BC_PAYER_KEY}\n`, 0o600);
  put(home, ".brainchain/worker.key", `${FAKE_BC_WORKER_KEY}\n`, 0o600);
  put(home, `.brainchain/spend-mainnet-${BC_PAYER_ADDRESS}.json`, JSON.stringify({ day: "2026-11-15", spent: "2000000", note: "bc-spend-marker-4663" }), 0o600);
  put(home, ".config/brainchain-worker/state.json", JSON.stringify({ watched: 3, note: "bc-worker-state-marker" }), 0o600);
}

const SKILL_FRONT = `---
name: brainchain
description: Hand a scoped task to a graded worker on BrainChain and pay only if the result is accepted.
homepage: https://docs.usebrainchain.com/agents
---

# BrainChain

Post one scoped task, check the wallet first, and never open the key file.
`;

const WORKER_SKILL = `---
name: brainchain-worker
description: Earn USDG on BrainChain doing the tasks Jev hires this agent for, each one in a sandboxed turn.
homepage: https://docs.usebrainchain.com/run-a-worker
---

# BrainChain worker

Every task runs as its own OpenClaw turn inside a container.
`;

/** Claude Code: the entry `claude mcp add` writes from BrainChain's docs, plus a skill notes file linked to the key. */
export function buildClaudeCodeBrainChain(home: string) {
  const r = join(home, ".claude");
  plantBrainChainKeys(home);
  put(r, "CLAUDE.md", "# Preferences\n\n- BrainChain: only public, one-shot tasks. Never send private code.\n");
  put(home, ".claude.json", JSON.stringify({
    numStartups: 2,
    mcpServers: { brainchain: { type: "stdio", command: "npx", args: ["-y", "brainchain-mcp@0.9.3"], env: { BRAINCHAIN_PAYER_KEY_FILE: "~/.brainchain/payer.key" } } }
  }, null, 2));
  put(r, "skills/notes/SKILL.md", "---\nname: notes\ndescription: Personal notes.\n---\n\nKeep notes short.\n");
  trySymlink(join(home, ".brainchain/payer.key"), join(r, "skills/notes/NOTES.md"));
  return r;
}

/** Cursor: the repo's mcp.json, paying on Base with a daily cap. */
export function buildCursorBrainChain(home: string) {
  const p = join(home, "cursor-brainchain");
  plantBrainChainKeys(home);
  put(p, ".cursor/rules/brainchain.mdc", "---\ndescription: BrainChain rules\nalwaysApply: true\n---\n\nPublic tasks only.\n");
  put(p, ".cursor/mcp.json", JSON.stringify({ mcpServers: { brainchain: { command: "npx", args: ["-y", "brainchain-mcp@0.9.3"], env: { BRAINCHAIN_PAYER_KEY: "${BRAINCHAIN_PAYER_KEY}", BRAINCHAIN_PAY_ON: "base", BRAINCHAIN_DAILY_UNITS: "5000000" } } } }, null, 2));
  return p;
}

/** Codex: a raw payer key typed into the entry, with literal limits. */
export function buildCodexBrainChain(home: string) {
  const r = join(home, ".codex");
  plantBrainChainKeys(home);
  put(r, "AGENTS.md", "# Rules\n\n- BrainChain: one brief, one result.\n");
  put(r, "config.toml", `model = "gpt-5-codex"

[mcp_servers.brainchain]
command = "npx"
args = ["-y", "brainchain-mcp@0.9.3"]

[mcp_servers.brainchain.env]
BRAINCHAIN_PAYER_KEY = "${FAKE_BC_PAYER_KEY}"
BRAINCHAIN_MAX_PRICE_UNITS = "1000000"
BRAINCHAIN_BUDGET_UNITS = "3000000"
BRAINCHAIN_DAILY_UNITS = "3000000"
`);
  return r;
}

/** Gemini CLI: the global brainchain-mcp command on the testnet. */
export function buildGeminiBrainChain(home: string) {
  const g = join(home, ".gemini");
  plantBrainChainKeys(home);
  put(g, "GEMINI.md", "# Rules\n\nPublic tasks only.\n");
  put(g, "settings.json", JSON.stringify({ mcpServers: { brainchain: { command: "brainchain-mcp", env: { BRAINCHAIN_NETWORK: "testnet", BRAINCHAIN_PAYER_KEY_FILE: "~/.brainchain/payer.key", BRAINCHAIN_DAILY_UNITS: "2000000" } } } }, null, 2));
  return g;
}

/** Hermes: the network and the daily cap as references. */
export function buildHermesBrainChain(home: string) {
  const r = buildHermes(home);
  plantBrainChainKeys(home);
  put(r, "config.yaml", `# Hermes configuration
model:
  default: anthropic/claude-sonnet-4-5
  provider: openrouter
mcp_servers:
  brainchain:
    command: npx
    args: ["-y", "brainchain-mcp@0.9.3"]
    env:
      BRAINCHAIN_NETWORK: \${BRAINCHAIN_NETWORK}
      BRAINCHAIN_PAYER_KEY_FILE: \${BRAINCHAIN_PAYER_KEY_FILE}
      BRAINCHAIN_DAILY_UNITS: \${BRAINCHAIN_DAILY_UNITS}
`);
  return r;
}

/**
 * OpenClaw: the server as the brainchain skill's `openclaw mcp set` registers it, both BrainChain skills,
 * and the worker skill's key wired through OpenClaw's secrets settings.
 */
export function buildOpenClawBrainChain(home: string) {
  const r = join(home, ".openclaw");
  plantBrainChainKeys(home);
  put(r, "openclaw.json", `// OpenClaw configuration
{
  agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } } },
  mcp: {
    servers: {
      brainchain: { command: "npx", args: ["-y", "brainchain-mcp@0.9.3"], env: { BRAINCHAIN_PAYER_KEY_FILE: "~/.brainchain/payer.key", BRAINCHAIN_PAY_ON: "base", BRAINCHAIN_BUDGET_UNITS: "5000000", BRAINCHAIN_DAILY_UNITS: "5000000" } },
    },
  },
  secrets: { providers: { "brainchain-worker": { source: "file", path: "~/.brainchain/worker.key", mode: "singleValue" } } },
  skills: { entries: { "brainchain-worker": { apiKey: { source: "file", provider: "brainchain-worker", id: "value" } } } },
}
`);
  put(r, "workspace/AGENTS.md", "# AGENTS.md\n\n- Public tasks only.\n");
  put(r, "workspace/SOUL.md", "You are Atlas, a careful research agent.\n");
  put(r, "workspace/skills/brainchain/SKILL.md", SKILL_FRONT);
  put(r, "workspace/skills/brainchain/scripts/wallet_check.py", "#!/usr/bin/env python3\nprint('{\"ready\": true}')\n", 0o755);
  put(r, "workspace/skills/brainchain-worker/SKILL.md", WORKER_SKILL);
  put(r, "workspace/skills/brainchain-worker/scripts/engine.sh", "#!/bin/sh\nexit 0\n", 0o755);
  return r;
}
