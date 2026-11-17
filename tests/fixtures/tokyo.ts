import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Tokyo Futuro setups as Tokyo documents them (agents.md, SKILL.md, tokyo-mcp.mjs and tokyo-futuro-mcp
 * 0.1.2, read Nov 17, 2026): the hosted server `claude mcp add --transport http tokyo-futuro
 * https://tokyofuturo-syndicates.gate-server.workers.dev/mcp`, and the local server
 * `TOKYO_URL=<host> AGENT_KEY=0x... AGENT_NAME="My Agent" npx tokyo-futuro-mcp` (or `node tokyo-mcp.mjs`).
 * The wallet key and the sign-in token below are fake.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const TOKYO_HOSTED = "https://tokyofuturo-syndicates.gate-server.workers.dev/mcp";
export const TOKYO_TEST_HOSTED = "https://tokyofuturo-syndicates-test.gate-server.workers.dev/mcp";
export const TOKYO_URL = "https://tokyofuturo-syndicates.gate-server.workers.dev";
export const FAKE_AGENT_KEY = "0x" + "7c41e9b2d8a35f60".repeat(4);
/** Shaped like Tokyo's sign-in token: <wallet>.<expiry>.<epoch>.<hmac>. */
export const FAKE_TOKYO_TOKEN = "0x2d6f3da021226fc62579099d05b1a27f72484081.1795497600.3.k3J9xQ2mP7vR4tW8yZ1bC5dF6gH0jL2n";
/** Must never appear in any plan, receipt, destination, backup or export. */
export const FAKE_TOKYO_SECRETS = [FAKE_AGENT_KEY, FAKE_TOKYO_TOKEN];

/** Claude Code: the hosted server and the local server with its key, as Tokyo documents them. */
export function buildClaudeCodeTokyo(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Preferences\n\n- In Tokyo Futuro, take small jobs first.\n");
  put(home, ".claude.json", JSON.stringify({
    mcpServers: {
      "tokyo-futuro": { type: "http", url: TOKYO_HOSTED },
      "tokyo-local": { type: "stdio", command: "npx", args: ["-y", "tokyo-futuro-mcp@0.1.2"], env: { TOKYO_URL, AGENT_KEY: FAKE_AGENT_KEY, AGENT_NAME: "Kestrel", AGENT_ERC8004_ID: "20708" } }
    }
  }, null, 2));
  return r;
}

/**
 * A house agent exported as an agent folder, the way the Diego demo is set up: persona, rules, notes,
 * Tokyo's skill and the local server in .mcp.json with AGENT_KEY as a reference. One note carries a
 * sign-in token by mistake, which Nomad must remove.
 */
export function buildTokyoAgentFolder(root: string) {
  put(root, "SOUL.md", "You are Diego Mori, a citizen of Tokyo Futuro.\n");
  put(root, "AGENTS.md", "# Diego Mori\n\n- Wake, read your notes, take at most one job, then write a note.\n");
  put(root, "memory/notes.md", `- Stopped on auditor_not_eligible when taking job 8143; try non-audit jobs next.\n- Session token ${FAKE_TOKYO_TOKEN} (do not share).\n`);
  put(root, "skills/tokyo-futuro/SKILL.md", "---\nname: tokyo-futuro\ndescription: Act in Tokyo Futuro, an onchain city on Robinhood Chain.\n---\n\nNever sign or send anything without the user's approval.\n");
  put(root, ".mcp.json", JSON.stringify({
    mcpServers: {
      "tokyo-futuro": { command: "npx", args: ["-y", "tokyo-futuro-mcp@0.1.2"], env: { TOKYO_URL, AGENT_KEY: "${AGENT_KEY}", AGENT_NAME: "Diego Mori" } }
    }
  }, null, 2));
  return root;
}
