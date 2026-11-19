import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHermes } from "./platforms";

/**
 * Zolva setups as Zolva documents them (zolvaagent.app/docs/mcp, read Nov 19, 2026): the hosted server
 * https://zolvaagent.app/mcp over Streamable HTTP, read-only with no key, and an optional key in
 * "Authorization: Bearer zk_...". Claude Code (`claude mcp add --transport http zolva ... --header`) and
 * Cursor write the key into their config; Codex reads it from ZOLVA_KEY (bearer_token_env_var).
 * The key is "zk_" and 43 base64url characters, as Zolva's source makes it. Every key below is fake.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const FAKE_ZOLVA_KEY = "zk_" + "Q7mVx2Lr9Tz4Kp8Ns1Wd6Hc3Jb5Fy0Ga7Pe2Ru4Si9O";
export const FAKE_ZOLVA_KEY_2 = "zk_" + "b3Cd5Ef7Gh9Jk2Lm4Np6Qr8St0Uv1Wx3Yz5Ab7Cd9E_";
/** Must never appear in any plan, receipt, destination, backup or export. */
export const FAKE_ZOLVA_SECRETS = [FAKE_ZOLVA_KEY, FAKE_ZOLVA_KEY_2];
export const ZOLVA_URL = "https://zolvaagent.app/mcp";

/** Claude Code, as `claude mcp add --transport http zolva <url> --header "Authorization: Bearer zk_..."` writes it. */
export function buildClaudeCodeZolva(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", `# Rules\n\n- Before suggesting a Zolva strategy, backtest it.\n- My old key was ${FAKE_ZOLVA_KEY_2}, revoked.\n`);
  put(home, ".claude.json", JSON.stringify({
    numStartups: 2,
    mcpServers: { zolva: { type: "http", url: ZOLVA_URL, headers: { Authorization: `Bearer ${FAKE_ZOLVA_KEY}` } } }
  }, null, 2));
  return r;
}

/** Codex, as Zolva's docs set it up: the key in ZOLVA_KEY, sent as a bearer token. */
export function buildCodexZolva(home: string) {
  const r = join(home, ".codex");
  put(r, "AGENTS.md", "# Rules\n\n- Compare every Zolva agent with simply holding its markets.\n");
  put(r, "config.toml", `model = "gpt-5-codex"

[mcp_servers.zolva]
url = "${ZOLVA_URL}"
bearer_token_env_var = "ZOLVA_KEY"
`);
  return r;
}

/** Cursor, with the key written into .cursor/mcp.json as Zolva's Cursor example shows. */
export function buildCursorZolva(project: string) {
  put(project, ".cursorrules", "Read Zolva's decision log before answering questions about an agent.\n");
  put(project, ".cursor/mcp.json", JSON.stringify({ mcpServers: { zolva: { url: ZOLVA_URL, headers: { Authorization: `Bearer ${FAKE_ZOLVA_KEY}` } } } }, null, 2));
  return project;
}

/** Hermes: the hosted server with no key (read-only). */
export function buildHermesZolva(home: string) {
  const r = buildHermes(home);
  put(r, "config.yaml", `# Hermes configuration
model:
  default: anthropic/claude-sonnet-4-5
  provider: openrouter
mcp_servers:
  zolva:
    url: "${ZOLVA_URL}"
`);
  return r;
}
