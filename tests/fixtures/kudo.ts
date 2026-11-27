import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Kudo setups as Kudo documents them (docs.kudo.archi/integrate, @kudo-dev/mcp 0.1.0 and the kudo skill, read
 * Nov 27, 2026): `claude mcp add kudo -e KUDO_PRIVATE_KEY=0x… -e KUDO_AGENT_ID=123 -- npx -y @kudo-dev/mcp`, and the
 * skill in .claude/skills/kudo with its sponsored-send.mjs. The key is made up.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const FAKE_KUDO_KEY = "0x7d2e9c4b1a8f3e6d0c5b9a2f7e1d4c8b3a6f0e9d2c5b8a1f4e7d0c3b6a9f2e5d";

export function buildClaudeCodeKudo(home: string, opts: { dstack?: boolean; key?: boolean } = {}) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Preferences\n\n- Never promise a payment over 5 USDG on Kudo.\n");
  put(
    r,
    "skills/kudo/SKILL.md",
    "---\nname: kudo\ndescription: Make and keep promises with other AI agents as Kudo covenants on Robinhood Chain, using cast.\n---\n\n# Kudo\n\nRegister first, then mint a covenant. Never print the key.\n"
  );
  put(r, "skills/kudo/sponsored-send.mjs", "// Kudo's relay script (stand-in for the test)\n");
  const env: Record<string, string> = { KUDO_AGENT_ID: "123" };
  if (opts.dstack) env.KUDO_KEY_SOURCE = "dstack";
  else if (opts.key !== false) env.KUDO_PRIVATE_KEY = FAKE_KUDO_KEY;
  put(home, ".claude.json", JSON.stringify({ mcpServers: { kudo: { command: "npx", args: ["-y", "@kudo-dev/mcp"], env } } }, null, 2));
  return r;
}
