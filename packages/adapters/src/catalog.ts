import { capabilityMatrix, type AdapterInfo, type CategoryCapability } from "@nomad/core";

/**
 * Static information about every adapter. This module has no Node dependencies so
 * the web interface can render the platform matrix in the browser.
 */

const full: CategoryCapability = { read: "full", write: "full" };
const convert = (notes?: string): CategoryCapability => ({ read: "convert", write: "convert", notes });
const manual = (notes?: string): CategoryCapability => ({ read: "manual", write: "manual", notes });
const none = (notes?: string): CategoryCapability => ({ read: "unsupported", write: "unsupported", notes });
const rw = (read: CategoryCapability["read"], write: CategoryCapability["write"], notes?: string): CategoryCapability => ({ read, write, notes });

export const GENERIC_INFO: AdapterInfo = {
  id: "generic",
  displayName: "Agent folder",
  category: "generic",
  support: "FULL",
  adapterVersion: "1.0.0",
  supportedVersions: "Universal Agent Format 1.0, plus Markdown agent folders",
  description:
    "An unpacked Nomad package, or any folder of Markdown agent files (AGENTS.md, SOUL.md, MEMORY.md, skills/). Lossless for packages.",
  defaultLocations: [],
  multiAgent: false,
  configFormats: ["JSON", "Markdown"],
  capabilities: capabilityMatrix({}, full),
  limitations: ["Plain Markdown folders are read heuristically. Unpacked Nomad packages are read exactly."]
};

export const CLAUDE_CODE_INFO: AdapterInfo = {
  id: "claude-code",
  displayName: "Claude Code",
  category: "coding-agent",
  support: "PARTIAL",
  adapterVersion: "1.0.0",
  supportedVersions: "Claude Code 2.x configuration layout (CLAUDE.md, settings.json, agents/, skills/, commands/, MCP files)",
  description: "Reads and writes user (~/.claude) and project (.claude/) configuration, subagents, skills, slash commands, permissions and MCP servers.",
  docsUrl: "https://docs.claude.com/en/docs/claude-code/settings",
  defaultLocations: ["~/.claude"],
  multiAgent: true,
  configFormats: ["Markdown", "JSON", "YAML frontmatter"],
  capabilities: capabilityMatrix({
    identity: convert("Main agents have no name field. Nomad keeps the name in a managed block; subagents store it natively."),
    instructions: full,
    memory: convert("Memory is written to Markdown files imported from CLAUDE.md with @imports."),
    skills: full,
    tools: rw("full", "full", "MCP servers. Secret values become ${VAR} references you set in your environment."),
    integrations: manual("Connectors outside MCP need to be reconnected."),
    models: convert("Only Anthropic models are applied. Other models are recorded in the report."),
    permissions: rw("full", "convert", "allow, ask and deny rules map to tool rules. Browser, computer and schedule rules have no equivalent."),
    workflows: none("Claude Code has no local scheduler. Routines are kept in the package with setup steps."),
    knowledge: manual("Knowledge files are referenced, not copied into the configuration."),
    project: convert()
  }),
  limitations: [
    "User level MCP servers live in ~/.claude.json, which Claude Code also rewrites. Close Claude Code before migrating.",
    "Scheduled routines cannot be imported."
  ]
};

export const CODEX_INFO: AdapterInfo = {
  id: "codex",
  displayName: "Codex CLI",
  category: "coding-agent",
  support: "PARTIAL",
  adapterVersion: "1.0.0",
  supportedVersions: "Codex CLI configuration layout (AGENTS.md, config.toml, skills/, prompts/)",
  description: "Reads and writes AGENTS.md, config.toml (model, approval policy, sandbox, MCP servers), skills and custom prompts.",
  docsUrl: "https://github.com/openai/codex/blob/main/docs/config.md",
  defaultLocations: ["~/.codex"],
  multiAgent: false,
  configFormats: ["Markdown", "TOML"],
  capabilities: capabilityMatrix({
    identity: convert("Codex has no agent name or persona file. Persona is written into AGENTS.md."),
    instructions: full,
    memory: convert("Codex has no memory store. Memory is written as a section of AGENTS.md."),
    skills: full,
    tools: rw("full", "full", "MCP servers in config.toml. Secrets are not written; set them in your environment."),
    integrations: manual(),
    models: convert("Only OpenAI models are applied."),
    permissions: rw("full", "convert", "Mapped onto approval_policy, sandbox_mode and network access. Pattern rules cannot be enforced."),
    workflows: none("Codex has no scheduler."),
    knowledge: manual(),
    project: convert()
  }),
  limitations: ["One agent per Codex home. Copy mode is not available.", "TOML comments in config.toml are not preserved on merge."]
};

export const OPENCLAW_INFO: AdapterInfo = {
  id: "openclaw",
  displayName: "OpenClaw",
  category: "personal-agent",
  support: "PARTIAL",
  adapterVersion: "1.0.0",
  supportedVersions: "OpenClaw workspace layout (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, memory/, skills/) and cron/jobs.json",
  description: "Reads and writes OpenClaw agents, workspaces, memory, skills, cron jobs and per agent model and tool settings.",
  docsUrl: "https://docs.openclaw.ai/concepts/agent-workspace",
  defaultLocations: ["~/.openclaw"],
  multiAgent: true,
  configFormats: ["Markdown", "JSON5"],
  capabilities: capabilityMatrix({
    identity: full,
    instructions: full,
    memory: full,
    skills: full,
    tools: rw("convert", "manual", "OpenClaw reaches MCP servers through plugins. Nomad lists them for manual setup."),
    integrations: manual("Channels and credentials must be reconnected."),
    models: convert("Written as provider/model."),
    permissions: rw("convert", "convert", "Deny rules become tools.deny entries. Allow rules are documented, not applied."),
    workflows: full,
    knowledge: manual(),
    project: convert()
  }),
  limitations: [
    "openclaw.json is rewritten as JSON, so comments in it are not preserved. A backup is always taken.",
    "Session transcripts are not migrated."
  ]
};

export const HERMES_INFO: AdapterInfo = {
  id: "hermes",
  displayName: "Hermes Agent",
  category: "personal-agent",
  support: "PARTIAL",
  adapterVersion: "1.0.0",
  supportedVersions: "Hermes Agent home layout (~/.hermes: SOUL.md, memories/, skills/, cron/jobs.json, config.yaml, profiles/)",
  description: "Reads and writes Hermes profiles: persona, MEMORY.md and USER.md entries, skills, MCP servers, cron jobs and command allowlists.",
  docsUrl: "https://hermes-agent.nousresearch.com/docs/user-guide/features/memory",
  defaultLocations: ["~/.hermes"],
  multiAgent: true,
  configFormats: ["Markdown", "YAML", "JSON"],
  capabilities: capabilityMatrix({
    identity: convert("Persona lives in SOUL.md. The name is kept in a Nomad section."),
    instructions: convert("Hermes has no separate instruction file. Instructions are added to SOUL.md in a Nomad section."),
    memory: convert("Entries are written to MEMORY.md and USER.md with the § delimiter. Hermes enforces character limits."),
    skills: full,
    tools: rw("full", "convert", "MCP servers in config.yaml. Secrets belong in ~/.hermes/.env."),
    integrations: manual("Messaging platforms and OAuth must be reconnected."),
    models: convert(),
    permissions: rw("convert", "convert", "Shell allow patterns map to command_allowlist. Other rules are documented."),
    workflows: full,
    knowledge: manual(),
    project: convert()
  }),
  limitations: ["Hermes memory has character limits (2,200 for MEMORY.md and 1,375 for USER.md by default). Larger imports are reported."]
};

/** Phase 4 adapters: direct file integrations with limited testing. */
function fileInfo(
  id: string,
  displayName: string,
  description: string,
  defaultLocations: string[],
  opts: { mcp: boolean; skills?: boolean; memoryNote?: string; docsUrl?: string; formats: string[]; multiAgent?: boolean }
): AdapterInfo {
  return {
    id,
    displayName,
    category: "coding-agent",
    support: "PARTIAL",
    adapterVersion: "0.1.0",
    supportedVersions: "Documented rules and configuration files as of late 2026",
    description,
    docsUrl: opts.docsUrl,
    defaultLocations,
    multiAgent: !!opts.multiAgent,
    configFormats: opts.formats,
    capabilities: capabilityMatrix({
      identity: convert("Name and persona are written into the rules file."),
      instructions: full,
      memory: convert(opts.memoryNote ?? "Memory is written as a section of the rules file."),
      skills: opts.skills ? full : manual("No skill system. Skill instructions are listed for manual setup."),
      tools: opts.mcp ? convert("MCP servers are written to the platform MCP file.") : manual("MCP servers need manual setup."),
      integrations: manual(),
      models: manual("Model selection is left to the platform settings."),
      permissions: manual("Permissions are documented in the rules file, not enforced."),
      workflows: none(),
      knowledge: manual(),
      project: convert()
    }),
    limitations: ["Scheduled routines, model choice and permission enforcement stay in the application settings."]
  };
}

export const CURSOR_INFO = fileInfo("cursor", "Cursor", "Project rules in .cursor/rules (MDC), legacy .cursorrules and AGENTS.md, plus .cursor/mcp.json.", [], {
  mcp: true,
  formats: ["MDC", "Markdown", "JSON"],
  docsUrl: "https://docs.cursor.com/context/rules"
});
export const WINDSURF_INFO = fileInfo("windsurf", "Windsurf", "Workspace rules in .windsurf/rules and the legacy .windsurfrules file.", [], {
  mcp: false,
  formats: ["Markdown"],
  docsUrl: "https://docs.windsurf.com/windsurf/cascade/memories"
});
export const CLINE_INFO = fileInfo("cline", "Cline", "Workspace rules in .clinerules (file or folder).", [], { mcp: false, formats: ["Markdown"] });
export const ROO_INFO = fileInfo("roo-code", "Roo Code", "Rules in .roo/rules and project MCP servers in .roo/mcp.json.", [], {
  mcp: true,
  formats: ["Markdown", "JSON"]
});
export const CONTINUE_INFO = fileInfo("continue", "Continue", "Rules in .continue/rules (Markdown with frontmatter).", ["~/.continue"], {
  mcp: false,
  formats: ["Markdown", "YAML"]
});
export const OPENCODE_INFO = fileInfo(
  "opencode",
  "OpenCode",
  "AGENTS.md, agent definitions in agent/, and MCP servers in opencode.json.",
  ["~/.config/opencode"],
  { mcp: true, formats: ["Markdown", "JSON"], multiAgent: true, docsUrl: "https://opencode.ai/docs/config" }
);
export const GOOSE_INFO = fileInfo("goose", "Goose", ".goosehints instructions and extensions in config.yaml.", ["~/.config/goose"], {
  mcp: true,
  formats: ["Markdown", "YAML"]
});
export const AIDER_INFO = fileInfo("aider", "Aider", "CONVENTIONS.md loaded through the read list in .aider.conf.yml.", [], {
  mcp: false,
  formats: ["Markdown", "YAML"]
});
export const GEMINI_CLI_INFO = fileInfo("gemini-cli", "Gemini CLI", "GEMINI.md context files and MCP servers in settings.json.", ["~/.gemini"], {
  mcp: true,
  formats: ["Markdown", "JSON"],
  memoryNote: "Memory is written into GEMINI.md, which is where Gemini CLI saves its own memories.",
  docsUrl: "https://github.com/google-gemini/gemini-cli"
});

function guidedInfo(id: string, displayName: string, category: "hosted" | "framework", description: string, notes: string): AdapterInfo {
  const m = (n?: string): CategoryCapability => ({ read: "unsupported", write: "manual", notes: n });
  return {
    id,
    displayName,
    category,
    support: "GUIDED",
    adapterVersion: "0.1.0",
    supportedVersions: category === "hosted" ? "Official settings screens" : "Current public SDK",
    description,
    defaultLocations: [],
    multiAgent: false,
    configFormats: ["Markdown"],
    capabilities: capabilityMatrix({
      identity: m(),
      instructions: m(notes),
      memory: m(category === "hosted" ? "Memory items are listed for you to add in the product." : "Memory is included as context in the generated code."),
      skills: m("Skill instructions are included as text."),
      tools: m("Tools must be reconnected in the platform."),
      integrations: m(),
      models: m(),
      permissions: { read: "unsupported", write: "unsupported", notes: "Permissions cannot be configured from outside the platform." },
      workflows: m("Routines are listed with their schedule for manual setup."),
      knowledge: m("Upload knowledge files yourself."),
      project: { read: "unsupported", write: "unsupported" }
    }),
    limitations: [
      category === "hosted"
        ? "Hosted products do not expose agent import APIs. Nomad prepares the text and steps; you paste them in."
        : "Agents in this framework are defined in code. Nomad generates a starting point, not a running deployment."
    ]
  };
}

export const GUIDED_INFOS: AdapterInfo[] = [
  guidedInfo("chatgpt", "ChatGPT", "hosted", "Custom instructions, a GPT or a Project, with memory items to add.", "Custom instructions fields are limited to 1,500 characters each."),
  guidedInfo("claude-ai", "Claude (claude.ai)", "hosted", "Project instructions and a list of memories to add.", "Written as Project instructions."),
  guidedInfo("gemini", "Gemini", "hosted", "A Gem with instructions and knowledge files.", "Written as Gem instructions."),
  guidedInfo("grok", "Grok", "hosted", "Custom instructions for Grok.", "Written as custom instructions."),
  guidedInfo("perplexity", "Perplexity", "hosted", "A Space with instructions and files.", "Written as Space instructions."),
  guidedInfo("crewai", "CrewAI", "framework", "agents.yaml (role, goal, backstory) and a crew starter.", "Instructions become the backstory."),
  guidedInfo("langgraph", "LangGraph", "framework", "A Python agent with the system prompt and memory context.", "Instructions become the system prompt."),
  guidedInfo("langchain", "LangChain", "framework", "A Python agent with the system prompt and memory context.", "Instructions become the system prompt."),
  guidedInfo("autogen", "AutoGen", "framework", "An AssistantAgent definition.", "Instructions become the system message."),
  guidedInfo("semantic-kernel", "Semantic Kernel", "framework", "A ChatCompletionAgent definition.", "Instructions become the agent instructions."),
  guidedInfo("pydantic-ai", "PydanticAI", "framework", "An Agent with instructions.", "Instructions become the agent instructions."),
  guidedInfo("agno", "Agno", "framework", "An Agent with instructions.", "Instructions become the agent instructions."),
  guidedInfo("mastra", "Mastra", "framework", "A TypeScript Agent definition.", "Instructions become the agent instructions."),
  guidedInfo("dify", "Dify", "framework", "Prompt and knowledge setup steps for a Dify agent app.", "Instructions become the prompt."),
  guidedInfo("flowise", "Flowise", "framework", "System message and tool setup steps for an agent flow.", "Instructions become the system message."),
  guidedInfo("n8n", "n8n", "framework", "System message for the AI Agent node and schedule trigger settings.", "Instructions become the system message."),
  guidedInfo("letta", "Letta", "framework", "A Letta agent with persona and human memory blocks.", "Persona and user memory become memory blocks.")
];

export const ALL_INFOS: AdapterInfo[] = [
  OPENCLAW_INFO,
  CLAUDE_CODE_INFO,
  CODEX_INFO,
  HERMES_INFO,
  GENERIC_INFO,
  CURSOR_INFO,
  WINDSURF_INFO,
  CLINE_INFO,
  ROO_INFO,
  CONTINUE_INFO,
  OPENCODE_INFO,
  GOOSE_INFO,
  AIDER_INFO,
  GEMINI_CLI_INFO,
  ...GUIDED_INFOS
];

export function infoById(id: string): AdapterInfo | undefined {
  return ALL_INFOS.find((a) => a.id === id);
}
