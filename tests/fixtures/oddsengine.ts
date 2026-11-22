import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * OddsEngine setups as OddsEngine's team described them (Nov 22, 2026): the hosted server
 * https://api.oddsengine.live/mcp over Streamable HTTP with "Authorization: Bearer <api key>", or, for a client
 * that takes only an address, https://api.oddsengine.live/mcp/k/<api key>. Keys start "oe_live_". Every key
 * below is fake.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const FAKE_ODDSENGINE_KEY = "oe_live_" + "Hq7Lm2Vx9Tz4Kp8Ns1Wd6Rc3Jb5Fy0GaP2eUu4S";
export const FAKE_ODDSENGINE_KEY_2 = "oe_live_" + "b3Cd5Ef7Gh9Jk2Lm4Np6Qr8St0Uv1Wx3Yz5Ab7C";
/** Must never appear in any plan, receipt, destination, backup or export. */
export const FAKE_ODDSENGINE_SECRETS = [FAKE_ODDSENGINE_KEY, FAKE_ODDSENGINE_KEY_2];
export const ODDSENGINE_URL = "https://api.oddsengine.live/mcp";
export const ODDSENGINE_KEY_URL = `${ODDSENGINE_URL}/k/${FAKE_ODDSENGINE_KEY}`;

/** Claude Code, with the key in the header, as `claude mcp add --transport http` writes it. */
export function buildClaudeCodeOddsEngine(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", `# Rules\n\n- Scan every token with OddsEngine before buying.\n- Old key: ${FAKE_ODDSENGINE_KEY_2}\n`);
  put(home, ".claude.json", JSON.stringify({
    numStartups: 2,
    mcpServers: { oddsengine: { type: "http", url: ODDSENGINE_URL, headers: { Authorization: `Bearer ${FAKE_ODDSENGINE_KEY}` } } }
  }, null, 2));
  return r;
}

/** Cursor, with the key in the address (the form for clients that take only a URL). */
export function buildCursorOddsEngineKeyInAddress(project: string) {
  put(project, ".cursorrules", "Check a signature with OddsEngine before signing.\n");
  put(project, ".cursor/mcp.json", JSON.stringify({ mcpServers: { oddsengine: { url: ODDSENGINE_KEY_URL } } }, null, 2));
  return project;
}
