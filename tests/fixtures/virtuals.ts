import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Virtuals setups as Virtuals documents them (read Nov 26, 2026): the hosted server added with `claude mcp add
 * virtuals --transport http https://mcp.acp.virtuals.io/`, the acp-cli skill (github.com/Virtual-Protocol/acp-cli,
 * SKILL.md with metadata.acpCliVersion), and the deprecated virtuals-protocol-acp skill, a whole folder whose
 * config.json holds LITE_AGENT_API_KEY and a session token. The key and token here are made up.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const VIRTUALS_URL = "https://mcp.acp.virtuals.io/";
export const FAKE_LITE_KEY = "acp-1f3c9e7a2b8d4c6e0a5f9b3d7c1e8a2f";
export const FAKE_SESSION = "sess-9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a";

/** Claude Code: Virtuals' hosted server, the acp-cli skill and the old virtuals-protocol-acp skill folder. */
export function buildClaudeCodeVirtuals(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Preferences\n\n- Ask me before paying for anything or hiring an agent.\n");
  put(
    r,
    "skills/acp-cli/SKILL.md",
    '---\nname: acp-cli\nmetadata:\n  acpCliVersion: 1.0.28\ndescription: "Run autonomous agent operations on Virtuals Protocol."\n---\n\n# acp-cli\n\nRun every command yourself with --json. Authenticate with acp configure start, then acp configure complete.\n'
  );
  put(
    r,
    "skills/virtuals-protocol-acp/SKILL.md",
    '---\nname: virtuals-protocol-acp\ndescription: Hire specialised agents to handle any task.\nmetadata:\n  openclaw:\n    homepage: "https://app.virtuals.io"\n    primaryEnv: "LITE_AGENT_API_KEY"\n---\n\n# ACP (Agent Commerce Protocol)\n\nSearch ACP first using acp browse.\n'
  );
  put(r, "skills/virtuals-protocol-acp/references/acp-job.md", "# ACP jobs\n\nCreate a job with acp job create.\n");
  put(
    r,
    "skills/virtuals-protocol-acp/config.json",
    JSON.stringify({ SESSION_TOKEN: { token: FAKE_SESSION }, LITE_AGENT_API_KEY: FAKE_LITE_KEY, agents: [{ id: "1", name: "Scout", walletAddress: "0x1111111111111111111111111111111111111111", active: true }] }, null, 2)
  );
  put(home, ".claude.json", JSON.stringify({ mcpServers: { virtuals: { type: "http", url: VIRTUALS_URL } } }, null, 2));
  return r;
}
