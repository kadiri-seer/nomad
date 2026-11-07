import { createDocument } from "@nomad/core";
import { infoById } from "@nomad/adapters/catalog";
import type { AgentDocument } from "@nomad/schema";

/**
 * A sample agent used by the public demos. It mirrors a typical OpenClaw
 * personal assistant: persona, instructions, structured memory, a skill with a
 * script, an MCP server, a scheduled routine and a few permission rules.
 */
export function sampleAgent(platform = "openclaw"): AgentDocument {
  const d = createDocument({ name: "Kestrel", platform, description: "Calm, precise personal assistant", id: "01JD5XKZ8M3R7T0WQ4V2B6N9CE", now: new Date("2026-10-30T07:00:00Z") });
  d.identity.persona = "You are Kestrel, a calm and precise personal assistant. You prefer plain language and never pad answers.";
  d.identity.tone = "calm, precise";
  d.models.preferred = "anthropic/claude-sonnet-4-5";
  d.instructions.push(
    { id: "agents-md", kind: "agent", title: "AGENTS.md", content: "- Keep replies short and practical.\n- Before sending email, show me the draft.\n- Log decisions to the daily memory file." },
    { id: "tools-md", kind: "conventions", title: "TOOLS.md", content: "- The home server is called atlas.\n- Use the calendar tool for anything with a date." }
  );
  d.memory.push(
    { id: "user-1", kind: "profile", scope: "user", title: "About", content: "Name: Ada, based in Lagos (WAT).", tags: [] },
    { id: "user-2", kind: "preference", scope: "user", title: "Preferences", content: "Prefers bullet points over long paragraphs.", tags: [] },
    { id: "memory-1", kind: "fact", scope: "agent", title: "Facts", content: "The project codename is Harmattan.", tags: [] },
    { id: "memory-2", kind: "project", scope: "agent", title: "Projects", content: "Harmattan: migrate analytics to DuckDB by Q1.", tags: [] },
    { id: "daily-2026-10-30", kind: "daily-log", scope: "agent", title: "Log 2026-10-30", date: "2026-10-30", content: "- Agreed to send weekly reports on Fridays.", tags: [] }
  );
  d.skills.push({
    name: "weather-brief",
    description: "Summarise today's weather for Lagos in two lines.",
    instructions: "Run scripts/fetch.py and summarise the result in two lines.",
    dependencies: [],
    platforms: [],
    allowedTools: [],
    config: {},
    references: [],
    files: [{ path: "scripts/fetch.py", encoding: "utf8", content: "print('sunny')\n", executable: true }],
    frontmatter: {},
    invocation: "auto"
  });
  d.tools.push({ name: "github", kind: "mcp", mcp: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: { secretRef: "GITHUB_TOKEN", redacted: true } }, headers: {} }, permissions: [], platforms: [], enabled: true });
  d.integrations.push({ name: "telegram", kind: "channel", requiresAuth: true, config: {}, notes: "Messaging channel" });
  d.workflows.push({ id: "job-morning", name: "Morning brief", trigger: { kind: "cron", expr: "0 7 * * *" }, timezone: "Africa/Lagos", actions: [{ kind: "prompt", text: "Give me the morning brief: weather, calendar, top email." }], requiredTools: [], dependencies: [], conditions: [], sourceEnabled: true, enabled: false });
  d.permissions = { mode: "ask", rules: [{ capability: "browser", effect: "deny" }, { capability: "shell", effect: "ask" }], notes: [] };
  return d;
}

/**
 * The sample agent as it would look when read from a given platform: parts the
 * platform cannot hold (a Cursor project has no routines or chat channels, for
 * example) are left out, so the demo shows a realistic agent for every source.
 */
export function sampleFrom(platform: string): AgentDocument {
  const d = sampleAgent(platform);
  const caps = infoById(platform)?.capabilities;
  if (!caps) return d;
  const holds = (c: keyof typeof caps) => caps[c].read === "full" || caps[c].read === "convert";
  if (!holds("memory")) d.memory = [];
  if (!holds("skills")) d.skills = [];
  if (!holds("tools")) d.tools = [];
  if (!holds("integrations")) d.integrations = [];
  if (!holds("workflows")) d.workflows = [];
  if (!holds("models")) d.models = { ...d.models, preferred: undefined };
  if (!holds("permissions")) d.permissions = { mode: "ask", rules: [], notes: [] };
  return d;
}
