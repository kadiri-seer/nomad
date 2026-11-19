import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Upoch Guard setups as Upoch documents them (upoch.tech/docs/mcp, read Nov 19, 2026): the local MCP server
 * `upoch mcp` from @upoch/guard (`claude mcp add upoch -- upoch mcp`, or `{"command":"upoch","args":["mcp"]}`
 * in other apps). Keys live in ~/.upoch/secrets.json (or UPOCH_HOME), which Nomad never reads. Every key
 * below is fake, and the planted secrets.json is there to prove it is never read.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const FAKE_UPOCH_OWNER_KEY = "0x" + "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d";
export const FAKE_UPOCH_ENCRYPTION_KEY = "9a3c" + "e1f07b6d2c58a4e19f3b7c0d6e2a5f81b4c9d7e3a6f0b2c8d5e1f4a7b0c3d6e9";

/** A planted ~/.upoch, as `upoch setup` leaves it. Nomad must never read it. */
export function plantUpochHome(home: string, dir = ".upoch") {
  put(home, `${dir}/secrets.json`, JSON.stringify({ ownerKey: FAKE_UPOCH_OWNER_KEY, executorKey: FAKE_UPOCH_OWNER_KEY.replace("4f", "5e"), encryptionKey: FAKE_UPOCH_ENCRYPTION_KEY }, null, 2));
  put(home, `${dir}/config.json`, JSON.stringify({ network: "mainnet", agentName: "kestrel", workflowId: "5", maxCheckpointsPerDay: 100 }, null, 2));
}

/** Claude Code, as `claude mcp add upoch -- upoch mcp` writes it. */
export function buildClaudeCodeUpoch(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Rules\n\n- Checkpoint with Upoch before and after every trade.\n");
  put(home, ".claude.json", JSON.stringify({ numStartups: 2, mcpServers: { upoch: { type: "stdio", command: "upoch", args: ["mcp"], env: {} } } }, null, 2));
  return r;
}

/** Codex, with Upoch's folder somewhere else (UPOCH_HOME) and the server run through npx. */
export function buildCodexUpoch(home: string) {
  const r = join(home, ".codex");
  put(r, "AGENTS.md", "# Rules\n\n- Restore from Upoch when a run starts.\n");
  put(r, "config.toml", `model = "gpt-5-codex"

[mcp_servers.upoch]
command = "npx"
args = ["-y", "@upoch/guard@0.1.4", "mcp"]

[mcp_servers.upoch.env]
UPOCH_HOME = "/home/kestrel/agents/upoch"
`);
  return r;
}
