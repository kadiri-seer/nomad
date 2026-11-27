import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Zero Lux's hosted server as Zero Lux documents it (zerolux.fun/connect, read Nov 27, 2026). Keyless. */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const ZEROLUX_URL = "https://zerolux.fun/mcp";

export function buildClaudeCodeZeroLux(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Preferences\n\n- Ask me before hiring any agent that costs more than 0.10 USDG.\n");
  put(home, ".claude.json", JSON.stringify({ mcpServers: { zerolux: { type: "http", url: ZEROLUX_URL } } }, null, 2));
  return r;
}
