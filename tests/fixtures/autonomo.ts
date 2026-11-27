import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Autonomo setups as Autonomo documents them (autonomo.fun/docs/agents, autonomo-mcp 0.1.3 and the autonomo skill,
 * read Nov 27, 2026): `claude mcp add autonomo -e AUTONOMO_WALLET_KEY=0x… -- npx -y autonomo-mcp`, with spending
 * limits, and the skill in .claude/skills/autonomo. The key is made up.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const FAKE_AUTONOMO_KEY = "0x3c9e1f7a2b8d4c6e0a5f9b3d7c1e8a2f4b6d0c9e1a3f5b7d9c2e4a6f8b0d1c3e";

export function buildClaudeCodeAutonomo(home: string, opts: { windows?: boolean; limits?: boolean } = {}) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Preferences\n\n- Check the price with get_price before any paid call.\n");
  put(
    r,
    "skills/autonomo/SKILL.md",
    '---\nname: autonomo\ndescription: Find paid x402 APIs on Autonomo and pay for one call at a time from a small agent wallet, using the autonomo-sdk command line.\nlicense: MIT\nmetadata:\n  author: autonomo\n  version: "1.0"\n  homepage: https://autonomo.fun\n---\n\n# Autonomo: find and pay for APIs\n\nCheck the price before paying: run the same command with --dry-run first.\n'
  );
  const env: Record<string, string> = { AUTONOMO_WALLET_KEY: FAKE_AUTONOMO_KEY };
  if (opts.limits !== false) Object.assign(env, { AUTONOMO_DAILY_USDG: "0.5", AUTONOMO_MAX_USDG_PER_CALL: "0.02", AUTONOMO_PAY_WITH: "usdg" });
  const server = opts.windows ? { command: "cmd", args: ["/c", "npx", "-y", "autonomo-mcp"], env } : { command: "npx", args: ["-y", "autonomo-mcp"], env };
  put(home, ".claude.json", JSON.stringify({ mcpServers: { autonomo: server } }, null, 2));
  return r;
}
