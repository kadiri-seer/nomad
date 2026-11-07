import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Realistic platform layouts, modeled on each platform's documented files.
 * Built into a temporary home directory for every test so tests never touch
 * the real home directory.
 */

function put(root: string, rel: string, content: string, mode?: number) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mode) chmodSync(p, mode);
}

// Fake credentials with valid shapes. They are not real keys.
export const FAKE_GITHUB_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
export const FAKE_OPENAI_KEY = "sk-proj-" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa";
export const FAKE_OPENROUTER_KEY = "sk-or-v1-" + "0123456789abcdef".repeat(4);

export function buildOpenClaw(home: string) {
  const r = join(home, ".openclaw");
  put(
    r,
    "openclaw.json",
    `// OpenClaw configuration
{
  agents: {
    defaults: {
      workspace: "~/.openclaw/workspace",
      model: { primary: "anthropic/claude-sonnet-4-5" },
    },
  },
  tools: { deny: ["browser"] },
  channels: { telegram: { enabled: true, botToken: "\${TELEGRAM_BOT_TOKEN}" } },
}
`
  );
  const w = "workspace";
  put(r, `${w}/AGENTS.md`, `# AGENTS.md\n\n- Keep replies short and practical.\n- Before sending email, show me the draft.\n- Log decisions to memory/YYYY-MM-DD.md.\n`);
  put(r, `${w}/SOUL.md`, `You are Kestrel, a calm and precise personal assistant.\nYou prefer plain language and never pad answers.\n`);
  put(r, `${w}/IDENTITY.md`, `# IDENTITY.md - Who Am I?\n\n- **Name:** Kestrel\n- **Creature:** small falcon\n- **Vibe:** calm, precise\n- **Emoji:** 🪶\n`);
  put(r, `${w}/USER.md`, `# USER.md\n\n## About\n- Name: Ada, based in Lagos (WAT).\n- Works as a data engineer.\n\n## Preferences\n- Prefers bullet points over long paragraphs.\n- Morning briefings before 8am.\n`);
  put(r, `${w}/TOOLS.md`, `# TOOLS.md\n\n- The home server is called "atlas".\n- Weather API key for tests: ${FAKE_OPENAI_KEY}\n`);
  put(r, `${w}/HEARTBEAT.md`, `# HEARTBEAT.md\n\n- Check unread email from family.\n`);
  put(r, `${w}/MEMORY.md`, `# MEMORY.md\n\n## Facts\n- Ada's sister is visiting in December.\n- The project codename is Harmattan.\n\n## Projects\n- Harmattan: migrate analytics to DuckDB by Q1.\n`);
  put(r, `${w}/memory/2026-10-30.md`, `# 2026-10-30\n\n- Agreed to send weekly reports on Fridays.\n`);
  put(r, `${w}/skills/weather-brief/SKILL.md`, `---\nname: weather-brief\ndescription: Summarise today's weather for Lagos in two lines.\n---\n\n# Weather brief\n\nRun scripts/fetch.py and summarise the result in two lines.\n`);
  put(r, `${w}/skills/weather-brief/scripts/fetch.py`, `import sys\nprint("sunny")\n`, 0o755);
  put(
    r,
    "cron/jobs.json",
    JSON.stringify(
      {
        version: 1,
        jobs: [
          {
            id: "job-morning",
            name: "Morning brief",
            enabled: true,
            schedule: { kind: "cron", expr: "0 7 * * *", tz: "Africa/Lagos" },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "Give me the morning brief: weather, calendar, top email." },
            delivery: { mode: "announce", channel: "telegram", to: "123456" }
          }
        ]
      },
      null,
      2
    )
  );
  put(r, "credentials/telegram.json", `{"token":"never-read"}`);
  return r;
}

export function buildClaudeCode(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", `# Personal preferences\n\n- Use TypeScript strict mode.\n- Run tests before committing.\n- Never push to main without asking.\n`);
  put(
    r,
    "settings.json",
    JSON.stringify(
      {
        model: "claude-opus-4-1",
        permissions: {
          allow: ["Bash(npm run test:*)", "Read(~/projects/**)"],
          ask: ["Bash(git push:*)"],
          deny: ["Read(./.env)", "WebFetch"],
          defaultMode: "default"
        },
        env: { DEBUG: "1" }
      },
      null,
      2
    )
  );
  put(r, "agents/code-reviewer.md", `---\nname: code-reviewer\ndescription: Reviews diffs for bugs and style issues.\ntools: Read, Grep, Glob\nmodel: sonnet\n---\n\nYou are a senior reviewer. Point out bugs first, then style.\n`);
  put(r, "skills/pdf-tools/SKILL.md", `---\nname: pdf-tools\ndescription: Extract text and tables from PDF files.\nallowed-tools: Bash(python:*)\n---\n\nUse pdfplumber to extract text. Keep tables as Markdown.\n`);
  put(r, "skills/pdf-tools/extract.py", `import pdfplumber\n`);
  put(r, "commands/release-notes.md", `---\ndescription: Draft release notes from recent commits\nargument-hint: [version]\n---\n\nWrite release notes for $ARGUMENTS from git log.\n`);
  put(
    home,
    ".claude.json",
    JSON.stringify(
      {
        numStartups: 12,
        oauthAccount: { emailAddress: "ada@example.com" },
        mcpServers: { github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: FAKE_GITHUB_TOKEN } } }
      },
      null,
      2
    )
  );
  return r;
}

export function buildCodex(home: string) {
  const r = join(home, ".codex");
  put(r, "AGENTS.md", `# Working agreements\n\n- Prefer small, reviewable commits.\n- Explain risky shell commands before running them.\n`);
  put(
    r,
    "config.toml",
    `# Codex configuration
model = "gpt-5-codex"
model_reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = false

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]

[profiles.fast]
model = "gpt-5-mini"
`
  );
  put(r, "skills/sql-helper/SKILL.md", `---\nname: sql-helper\ndescription: Write and explain DuckDB SQL.\n---\n\nAlways show the query plan for queries over 1M rows.\n`);
  put(r, "prompts/review.md", `---\ndescription: Review the staged diff\n---\n\nReview the staged changes and list bugs first.\n`);
  return r;
}

export function buildHermes(home: string) {
  const r = join(home, ".hermes");
  put(
    r,
    "config.yaml",
    `# Hermes configuration
model:
  default: anthropic/claude-sonnet-4-5
  provider: openrouter
terminal:
  backend: local
mcp_servers:
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/ada/notes"]
command_allowlist:
  - git status
  - ls
memory:
  memory_char_limit: 2200
  user_char_limit: 1375
`
  );
  put(r, ".env", `OPENROUTER_API_KEY=${FAKE_OPENROUTER_KEY}\n`);
  put(r, "SOUL.md", `# Iris\n\nYou are Iris, a research assistant who cites sources and admits uncertainty.\n`);
  put(r, "memories/MEMORY.md", `User's main repo is ~/code/harmattan\n§\nThe staging server is staging.internal (SSH as deploy)\n§\nPrefers pytest over unittest\n`);
  put(r, "memories/USER.md", `Name: Ada\n§\nTimezone: Africa/Lagos\n§\nLikes concise answers with citations\n`);
  put(r, "skills/research/arxiv-digest/SKILL.md", `---\nname: arxiv-digest\ndescription: Summarise new arXiv papers in a topic.\n---\n\nSearch arXiv for the last 24 hours and summarise the top five papers.\n`);
  put(
    r,
    "cron/jobs.json",
    JSON.stringify(
      {
        jobs: [
          {
            id: "a1b2c3d4e5f6",
            name: "Daily research digest",
            prompt: "Summarise today's papers on retrieval augmented generation.",
            schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
            skills: ["arxiv-digest"],
            deliver: "telegram:-1001234567890",
            enabled: true,
            state: "scheduled"
          }
        ]
      },
      null,
      2
    )
  );
  return r;
}

export function buildAll(home: string) {
  return { openclaw: buildOpenClaw(home), claude: buildClaudeCode(home), codex: buildCodex(home), hermes: buildHermes(home) };
}
