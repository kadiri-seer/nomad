import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHermes } from "./platforms";

/**
 * HEY Research Lab setups as HEY documents them (heyresearch.xyz/developers/agents and
 * @hey-research-lab/mcp 0.3.5, read Nov 16, 2026): `claude mcp add --transport http hey-research
 * https://heyresearch.xyz/mcp`, the research profile at /mcp/research, an optional
 * "Authorization: Bearer <key>" header, and the local server `npx -y @hey-research-lab/mcp@0.3.5`
 * (or the hey-research-mcp command) with HEY_API_KEY, HEY_API_URL and HEY_MCP_PROFILE.
 * Read-only, no wallets. Every key below is fake.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const FAKE_HEY_KEY = "hey_live_" + "7Qm2Vx9Lr4Tz8Kp1Ns6Wd3Hc5Jb0Fy";
export const FAKE_HEY_KEY_2 = "hey_live_" + "Ab3Cd5Ef7Gh9Jk2Lm4Np6Qr8St0Uv1W";
/** Must never appear in any plan, receipt, destination, backup or export. */
export const FAKE_HEY_SECRETS = [FAKE_HEY_KEY, FAKE_HEY_KEY_2];
export const HEY_URL = "https://heyresearch.xyz/mcp";
export const HEY_RESEARCH_URL = "https://heyresearch.xyz/mcp/research";

/** Claude Code: the hosted server, the research profile with a key, and the local server with a key. */
export function buildClaudeCodeHey(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Preferences\n\n- For Robinhood Chain projects, ask HEY Research and link its evidence.\n");
  put(home, ".claude.json", JSON.stringify({
    numStartups: 3,
    mcpServers: {
      "hey-research": { type: "http", url: HEY_URL },
      "hey-research-research": { type: "http", url: HEY_RESEARCH_URL, headers: { Authorization: `Bearer ${FAKE_HEY_KEY}`, "x-hey-integration": "kestrel/1.0" } },
      "hey-local": { type: "stdio", command: "npx", args: ["-y", "@hey-research-lab/mcp@0.3.5"], env: { HEY_API_KEY: FAKE_HEY_KEY_2, HEY_MCP_PROFILE: "research" } }
    }
  }, null, 2));
  return r;
}

/** Codex: the hosted server, and a pinned local server reading another HEY address. */
export function buildCodexHey(home: string) {
  const r = join(home, ".codex");
  put(r, "AGENTS.md", "# Rules\n\n- Cite HEY's evidence links.\n");
  put(r, "config.toml", `model = "gpt-5-codex"

[mcp_servers.hey-research]
url = "${HEY_URL}"

[mcp_servers.hey-local]
command = "npx"
args = ["-y", "@hey-research-lab/mcp@0.3.5"]

[mcp_servers.hey-local.env]
HEY_API_URL = "https://hey.example.org"
HEY_MARKET_INTEGRITY = "public"
`);
  return r;
}

/** Gemini CLI: the hosted server, and the global hey-research-mcp command. */
export function buildGeminiHey(home: string) {
  const g = join(home, ".gemini");
  put(g, "GEMINI.md", "# Rules\n\nCite HEY's evidence.\n");
  put(g, "settings.json", JSON.stringify({ mcpServers: { "hey-research": { httpUrl: HEY_URL }, "hey-local": { command: "hey-research-mcp" } } }, null, 2));
  return g;
}

/** Hermes: the local server with its key and address as references. */
export function buildHermesHey(home: string) {
  const r = buildHermes(home);
  put(r, "config.yaml", `# Hermes configuration
model:
  default: anthropic/claude-sonnet-4-5
  provider: openrouter
mcp_servers:
  hey-local:
    command: npx
    args: ["-y", "@hey-research-lab/mcp"]
    env:
      HEY_API_KEY: \${HEY_API_KEY}
      HEY_API_URL: \${HEY_API_URL}
  hey-research:
    url: ${HEY_RESEARCH_URL}
`);
  return r;
}

/** OpenClaw: the hosted server as `openclaw mcp set` writes it. */
export function buildOpenClawHey(home: string) {
  const r = join(home, ".openclaw");
  put(r, "openclaw.json", `// OpenClaw configuration
{
  agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } } },
  mcp: {
    servers: {
      "hey-research": { url: "${HEY_URL}", transport: "streamable-http" },
    },
  },
}
`);
  put(r, "workspace/AGENTS.md", "# AGENTS.md\n\n- Cite HEY's evidence links.\n");
  put(r, "workspace/SOUL.md", "You are Atlas, a careful research agent.\n");
  return r;
}
