import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHermes } from "./platforms";

/**
 * Memoria setups as Memoria documents them (memoriaagent.site/docs.html, read Nov 19, 2026): the hosted server
 * https://www.memoriaagent.site/mcp over HTTP, with the agent's key in "Authorization: Bearer mem_..."
 * (`claude mcp add --transport http memoria "$MEMORIA_URL/mcp" --header "Authorization: Bearer $MEMORIA_API_KEY"`,
 * or the mcpServers shape with url and headers). The key is "mem_", 12 hex characters, "_" and 43 base64url
 * characters, as Memoria's source makes it. Every key below is fake.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const FAKE_MEMORIA_KEY = "mem_" + "3f9a1c2b7d4e" + "_" + "Q7mVx2Lr9Tz4Kp8Ns1Wd6Hc3Jb5Fy0Ga7Pe2Ru4Si9O";
export const FAKE_MEMORIA_KEY_2 = "mem_" + "a1b2c3d4e5f6" + "_" + "b3Cd5Ef7Gh9Jk2Lm4Np6Qr8St0Uv1Wx3Yz5Ab7Cd9E_";
/** Must never appear in any plan, receipt, destination, backup or export. */
export const FAKE_MEMORIA_SECRETS = [FAKE_MEMORIA_KEY, FAKE_MEMORIA_KEY_2];
export const MEMORIA_URL = "https://www.memoriaagent.site/mcp";

/** Claude Code, as Memoria's `claude mcp add` line writes it once the variables are filled in. */
export function buildClaudeCodeMemoria(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", `# Rules\n\n- Save what you learn about a customer to Memoria under customers/<name>.\n- Old key: ${FAKE_MEMORIA_KEY_2}\n`);
  put(home, ".claude.json", JSON.stringify({
    numStartups: 2,
    mcpServers: { memoria: { type: "http", url: MEMORIA_URL, headers: { Authorization: `Bearer ${FAKE_MEMORIA_KEY}` } } }
  }, null, 2));
  return r;
}

/** Codex, with the key read from MEMORIA_API_KEY. */
export function buildCodexMemoria(home: string) {
  const r = join(home, ".codex");
  put(r, "AGENTS.md", "# Rules\n\n- Look in Memoria before asking the user something twice.\n");
  put(r, "config.toml", `model = "gpt-5-codex"

[mcp_servers.memoria]
url = "${MEMORIA_URL}"
bearer_token_env_var = "MEMORIA_API_KEY"
`);
  return r;
}

/** Cursor, with the key written into .cursor/mcp.json as Memoria's generic example shows. */
export function buildCursorMemoria(project: string) {
  put(project, ".cursorrules", "Save decisions to Memoria with the reason.\n");
  put(project, ".cursor/mcp.json", JSON.stringify({ mcpServers: { memoria: { url: MEMORIA_URL, headers: { Authorization: `Bearer ${FAKE_MEMORIA_KEY}` } } } }, null, 2));
  return project;
}

/** Hermes: the server with no key, which Memoria refuses. */
export function buildHermesMemoria(home: string) {
  const r = buildHermes(home);
  put(r, "config.yaml", `# Hermes configuration
model:
  default: anthropic/claude-sonnet-4-5
  provider: openrouter
mcp_servers:
  memoria:
    url: "${MEMORIA_URL}"
`);
  return r;
}
