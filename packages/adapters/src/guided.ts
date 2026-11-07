import { stringify as stringifyYaml } from "yaml";
import type { AgentDocument } from "@nomad/schema";
import { slugify, type Adapter, type AdapterInfo, type GuidedKit, type DesiredFile } from "@nomad/core";
import { GUIDED_INFOS } from "./catalog";
import { describeTrigger, plainEntry, workflowPrompt } from "./util";

/**
 * Guided adapters cover hosted products and code-first frameworks. Nothing is
 * written into the platform: Nomad generates a kit (text to paste, code to start
 * from) and the steps to finish by hand.
 */

export function instructionsText(doc: AgentDocument, opts: { includeMemory?: boolean; includeSkills?: boolean } = {}): string {
  const parts: string[] = [];
  if (doc.identity.persona) parts.push(doc.identity.persona.trim());
  if (doc.identity.tone) parts.push(`Tone: ${doc.identity.tone}`);
  for (const i of doc.instructions) if (i.content.trim() && i.kind !== "user-context") parts.push(i.content.trim());
  if (opts.includeSkills && doc.skills.length) {
    parts.push(["Skills you can follow when relevant:", ...doc.skills.map((s) => `- ${s.name}: ${s.description || s.instructions.split("\n")[0]}`)].join("\n"));
  }
  if (opts.includeMemory) {
    const mem = memoryLines(doc);
    if (mem.length) parts.push(["Context you remember:", ...mem.map((m) => `- ${m}`)].join("\n"));
  }
  return parts.join("\n\n");
}

export function userContextText(doc: AgentDocument): string {
  const lines = [
    ...doc.instructions.filter((i) => i.kind === "user-context").map((i) => i.content.trim()),
    ...doc.memory.filter((m) => m.scope === "user" || m.kind === "profile" || m.kind === "preference").map((m) => plainEntry(m.content))
  ];
  return lines.join("\n");
}

function memoryLines(doc: AgentDocument): string[] {
  return doc.memory.filter((m) => m.kind !== "daily-log").map((m) => plainEntry(m.content).replace(/\s+/g, " "));
}

function py(s: string): string {
  return JSON.stringify(s);
}

function charNote(label: string, text: string, limit: number): string {
  return text.length > limit ? ` It is ${text.length} characters, over the ${limit} character limit, so shorten it before pasting.` : ` It is ${text.length} characters (limit ${limit}).`;
}

function commonFiles(doc: AgentDocument): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const mem = memoryLines(doc);
  if (mem.length) files.push({ path: "memory-items.md", content: `# Memory items for ${doc.name}\n\n${mem.map((m) => `- ${m}`).join("\n")}\n` });
  if (doc.skills.length) {
    files.push({ path: "skills.md", content: [`# Skills of ${doc.name}`, "", ...doc.skills.flatMap((s) => [`## ${s.name}`, "", s.description, "", s.instructions.trim(), ""])].join("\n") });
  }
  if (doc.workflows.length) {
    files.push({ path: "routines.md", content: [`# Routines of ${doc.name}`, "", ...doc.workflows.flatMap((w) => [`## ${w.name}`, "", `Schedule: ${describeTrigger(w.trigger, w.timezone)}`, "", workflowPrompt(w.actions), ""])].join("\n") });
  }
  if (doc.tools.length) {
    files.push({ path: "tools.md", content: [`# Tools used by ${doc.name}`, "", ...doc.tools.map((t) => `- ${t.name}${t.mcp ? ` (MCP ${t.mcp.transport}: ${t.mcp.command ?? t.mcp.url ?? ""} ${t.mcp.args.join(" ")})` : ""}`)].join("\n") + "\n" });
  }
  return files;
}

type KitBuilder = (doc: AgentDocument) => GuidedKit;

const KITS: Record<string, KitBuilder> = {
  chatgpt: (doc) => {
    const about = userContextText(doc);
    const how = instructionsText(doc);
    const gpt = instructionsText(doc, { includeMemory: true, includeSkills: true });
    return {
      files: [
        { path: "custom-instructions-about-you.txt", content: about + "\n" },
        { path: "custom-instructions-how-to-respond.txt", content: how + "\n" },
        { path: "gpt-instructions.txt", content: gpt + "\n" },
        ...commonFiles(doc)
      ],
      steps: [
        `For your whole account: open ChatGPT Settings, Personalization, Custom instructions. Paste custom-instructions-about-you.txt into the field about you.${charNote("", about, 1500)}`,
        `Paste custom-instructions-how-to-respond.txt into the field about how ChatGPT should respond.${charNote("", how, 1500)}`,
        `For a dedicated assistant instead: create a GPT or a Project and paste gpt-instructions.txt as its instructions.${charNote("", gpt, 8000)}`,
        "Tell ChatGPT to remember each line of memory-items.md if you use ChatGPT memory.",
        "Upload knowledge files to the GPT or Project. Tools and routines have to be set up again in ChatGPT."
      ]
    };
  },
  "claude-ai": (doc) => ({
    files: [{ path: "project-instructions.md", content: instructionsText(doc, { includeSkills: true }) + "\n" }, { path: "about-me.md", content: userContextText(doc) + "\n" }, ...commonFiles(doc)],
    steps: [
      "In Claude, create a Project and paste project-instructions.md into the Project instructions.",
      "Add about-me.md to the Project knowledge, or paste memory-items.md into Claude's memory import if your plan has memory.",
      "Upload knowledge files to the Project. Skills can be uploaded as Claude skills from skills.md.",
      "Connectors for tools have to be connected in Claude settings."
    ]
  }),
  gemini: (doc) => ({
    files: [{ path: "gem-instructions.md", content: instructionsText(doc, { includeMemory: true, includeSkills: true }) + "\n" }, ...commonFiles(doc)],
    steps: ["In Gemini, open Gems and create a new Gem.", "Paste gem-instructions.md into the instructions and give it the agent name.", "Add knowledge files to the Gem."]
  }),
  grok: (doc) => ({
    files: [{ path: "custom-instructions.md", content: instructionsText(doc, { includeMemory: true }) + "\n" }, ...commonFiles(doc)],
    steps: ["In Grok, open Settings and Customize, then paste custom-instructions.md into custom instructions."]
  }),
  perplexity: (doc) => ({
    files: [{ path: "space-instructions.md", content: instructionsText(doc, { includeMemory: true }) + "\n" }, ...commonFiles(doc)],
    steps: ["In Perplexity, create a Space and paste space-instructions.md into its instructions.", "Upload knowledge files to the Space."]
  }),
  crewai: (doc) => {
    const key = slugify(doc.name).replace(/-/g, "_");
    const agents = { [key]: { role: doc.identity.description ?? doc.name, goal: doc.description ?? `Act as ${doc.name}.`, backstory: instructionsText(doc, { includeMemory: true, includeSkills: true }) } };
    const tasks = Object.fromEntries(doc.workflows.map((w) => [slugify(w.name).replace(/-/g, "_"), { description: workflowPrompt(w.actions), expected_output: "A complete response", agent: key }]));
    return {
      files: [{ path: "config/agents.yaml", content: stringifyYaml(agents, { lineWidth: 0 }) }, ...(doc.workflows.length ? [{ path: "config/tasks.yaml", content: stringifyYaml(tasks, { lineWidth: 0 }) }] : []), ...commonFiles(doc)],
      steps: ["Create a crew with `crewai create crew <name>`.", "Replace config/agents.yaml (and tasks.yaml) with the generated files.", "Attach tools from tools.md with CrewAI tools or MCP adapters."]
    };
  },
  langgraph: (doc) => ({
    files: [
      { path: "agent.py", content: `from langgraph.prebuilt import create_react_agent\n\nSYSTEM_PROMPT = ${py(instructionsText(doc, { includeMemory: true, includeSkills: true }))}\n\n# Choose your model and tools.\nagent = create_react_agent(model="anthropic:claude-sonnet-4-5", tools=[], prompt=SYSTEM_PROMPT)\n` },
      ...commonFiles(doc)
    ],
    steps: ["pip install langgraph langchain-anthropic (or your model provider).", "Add tools from tools.md, for example with langchain-mcp-adapters.", "Use a checkpointer and a store if the agent needs persistent memory."]
  }),
  langchain: (doc) => ({
    files: [{ path: "agent.py", content: `from langchain.agents import create_agent\n\nSYSTEM_PROMPT = ${py(instructionsText(doc, { includeMemory: true, includeSkills: true }))}\n\nagent = create_agent(model="anthropic:claude-sonnet-4-5", tools=[], system_prompt=SYSTEM_PROMPT)\n` }, ...commonFiles(doc)],
    steps: ["pip install langchain langchain-anthropic (or your provider).", "Add tools from tools.md."]
  }),
  autogen: (doc) => ({
    files: [{ path: "agent.py", content: `from autogen_agentchat.agents import AssistantAgent\nfrom autogen_ext.models.openai import OpenAIChatCompletionClient\n\nagent = AssistantAgent(\n    name=${py(slugify(doc.name).replace(/-/g, "_"))},\n    model_client=OpenAIChatCompletionClient(model="gpt-4o"),\n    system_message=${py(instructionsText(doc, { includeMemory: true, includeSkills: true }))},\n)\n` }, ...commonFiles(doc)],
    steps: ["pip install autogen-agentchat autogen-ext[openai].", "Pick a model client and add tools."]
  }),
  "semantic-kernel": (doc) => ({
    files: [{ path: "agent.py", content: `from semantic_kernel.agents import ChatCompletionAgent\nfrom semantic_kernel.connectors.ai.open_ai import OpenAIChatCompletion\n\nagent = ChatCompletionAgent(\n    service=OpenAIChatCompletion(),\n    name=${py(slugify(doc.name).replace(/-/g, "_"))},\n    instructions=${py(instructionsText(doc, { includeMemory: true, includeSkills: true }))},\n)\n` }, ...commonFiles(doc)],
    steps: ["pip install semantic-kernel.", "Add plugins for the tools in tools.md."]
  }),
  "pydantic-ai": (doc) => ({
    files: [{ path: "agent.py", content: `from pydantic_ai import Agent\n\nagent = Agent(\n    "anthropic:claude-sonnet-4-5",\n    instructions=${py(instructionsText(doc, { includeMemory: true, includeSkills: true }))},\n)\n` }, ...commonFiles(doc)],
    steps: ["pip install pydantic-ai.", "Register tools with @agent.tool or MCP servers."]
  }),
  agno: (doc) => ({
    files: [{ path: "agent.py", content: `from agno.agent import Agent\nfrom agno.models.anthropic import Claude\n\nagent = Agent(\n    name=${py(doc.name)},\n    model=Claude(id="claude-sonnet-4-5"),\n    instructions=${py(instructionsText(doc, { includeMemory: true, includeSkills: true }))},\n)\n` }, ...commonFiles(doc)],
    steps: ["pip install agno anthropic.", "Add tools and a database for memory if needed."]
  }),
  mastra: (doc) => ({
    files: [{ path: "agent.ts", content: `import { Agent } from "@mastra/core/agent";\nimport { anthropic } from "@ai-sdk/anthropic";\n\nexport const agent = new Agent({\n  name: ${JSON.stringify(doc.name)},\n  instructions: ${JSON.stringify(instructionsText(doc, { includeMemory: true, includeSkills: true }))},\n  model: anthropic("claude-sonnet-4-5"),\n});\n` }, ...commonFiles(doc)],
    steps: ["Add agent.ts to your Mastra project and register it.", "Add tools and memory with @mastra/memory if needed."]
  }),
  dify: (doc) => ({
    files: [{ path: "prompt.md", content: instructionsText(doc, { includeMemory: true, includeSkills: true }) + "\n" }, ...commonFiles(doc)],
    steps: ["In Dify, create an Agent app.", "Paste prompt.md into the instructions.", "Add tools and upload knowledge to a Knowledge base."]
  }),
  flowise: (doc) => ({
    files: [{ path: "system-message.md", content: instructionsText(doc, { includeMemory: true, includeSkills: true }) + "\n" }, ...commonFiles(doc)],
    steps: ["In Flowise, create an Agentflow.", "Paste system-message.md into the agent node's system message.", "Connect tools and a memory node."]
  }),
  n8n: (doc) => ({
    files: [{ path: "system-message.md", content: instructionsText(doc, { includeMemory: true, includeSkills: true }) + "\n" }, ...commonFiles(doc)],
    steps: ["In n8n, add an AI Agent node and paste system-message.md into the system message option.", "Add a Schedule Trigger for each routine in routines.md. Leave the workflow inactive until you have tested it."]
  }),
  letta: (doc) => ({
    files: [
      {
        path: "create_agent.py",
        content: `from letta_client import Letta\n\nclient = Letta()\nagent = client.agents.create(\n    name=${py(slugify(doc.name))},\n    memory_blocks=[\n        {"label": "persona", "value": ${py(instructionsText(doc, { includeSkills: true }))}},\n        {"label": "human", "value": ${py(userContextText(doc))}},\n    ],\n    model="anthropic/claude-sonnet-4-5",\n    embedding="openai/text-embedding-3-small",\n)\n# Archival memory\nfor item in ${JSON.stringify(memoryLines(doc).filter(Boolean))}:\n    client.agents.passages.create(agent_id=agent.id, text=item)\n`
      },
      ...commonFiles(doc)
    ],
    steps: ["pip install letta-client and start a Letta server or use Letta Cloud.", "Run create_agent.py. Memory items are stored as archival passages."]
  })
};

export function createGuidedAdapter(info: AdapterInfo): Adapter {
  const build = KITS[info.id];
  const adapter: Adapter = {
    info,
    async detect() {
      return { detected: false, confidence: 0, evidence: [] };
    },
    async discover() {
      return [];
    },
    guidedKit(doc) {
      return build(doc);
    },
    async plan(doc, ctx) {
      const kit = build(doc);
      const steps = kit.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
      const files: DesiredFile[] = [
        ...kit.files.map((f) => ({ path: f.path, content: f.content, strategy: "replace" as const, component: "instructions" as const, description: `Kit file ${f.path}`, agentOwned: true })),
        { path: "STEPS.md", content: `# Move ${doc.name} to ${info.displayName}\n\n${steps}\n`, strategy: "replace", component: "instructions", description: "Setup steps", agentOwned: true }
      ];
      return {
        nativeId: "kit",
        files,
        notes: [{ level: "info", message: `${info.displayName} is a guided destination. Nomad writes a kit to ${ctx.root}; nothing is changed in ${info.displayName}.` }],
        manualSteps: kit.steps,
        conversions: [],
        unsupported: doc.permissions.rules.length ? [{ category: "permissions", item: `${doc.permissions.rules.length} rule(s)`, reason: `${info.displayName} permissions are managed inside the product.` }] : []
      };
    }
  };
  return adapter;
}

export const GUIDED_ADAPTERS = GUIDED_INFOS.map(createGuidedAdapter);
