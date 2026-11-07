/**
 * Example adapter: a platform that stores each agent as one JSON file.
 *
 *   <root>/agents/<id>.json
 *   { "name": "...", "system_prompt": "...", "memories": ["..."], "mcp": { "server": { "command": "...", "args": [] } } }
 *
 * It shows the whole contract written by hand: detection, discovery, reading,
 * planning writes, policy reporting and verification. Register it with
 * registerAdapter(jsonAgentAdapter) and it works in the CLI, web app and MCP server.
 */
import { join } from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import {
  capabilityMatrix,
  createDocument,
  mcpServersFromTools,
  toolsFromMcpServers,
  type Adapter,
  type DesiredFile,
  type PlannedWrite
} from "../src/index";

const ID = "json-agent";

export const jsonAgentAdapter: Adapter = {
  info: {
    id: ID,
    displayName: "JSON Agent (example)",
    category: "generic",
    support: "EXPERIMENTAL",
    adapterVersion: "1.0.0",
    supportedVersions: "Example format",
    description: "Example adapter from the Nomad SDK. One JSON file per agent.",
    defaultLocations: [],
    multiAgent: true,
    configFormats: ["JSON"],
    capabilities: capabilityMatrix({
      identity: { read: "full", write: "full" },
      instructions: { read: "full", write: "convert", notes: "All instructions are joined into system_prompt." },
      memory: { read: "full", write: "convert", notes: "Memories become plain strings." },
      tools: { read: "full", write: "full" },
      skills: { read: "unsupported", write: "unsupported" },
      workflows: { read: "unsupported", write: "unsupported" },
      permissions: { read: "unsupported", write: "unsupported" }
    }),
    limitations: ["Example only."]
  },

  async detect(root) {
    const ok = existsSync(join(root, "agents"));
    return { detected: ok, confidence: ok ? 0.5 : 0, evidence: ok ? ["agents/"] : [] };
  },

  async discover(root) {
    const dir = join(root, "agents");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
        return { nativeId: f.replace(/\.json$/, ""), name: j.name ?? f, location: join(dir, f), kind: "main" as const };
      });
  },

  async read(root, nativeId) {
    const path = join(root, "agents", `${nativeId}.json`);
    const j = JSON.parse(readFileSync(path, "utf8"));
    const doc = createDocument({ name: j.name ?? nativeId, platform: ID });
    if (typeof j.nomad_id === "string") doc.id = j.nomad_id;
    doc.instructions.push({ id: "system", kind: "system", content: String(j.system_prompt ?? "") });
    (j.memories ?? []).forEach((m: string, i: number) => doc.memory.push({ id: `mem-${i + 1}`, kind: "fact", scope: "agent", content: m, tags: [] }));
    doc.tools.push(...toolsFromMcpServers(j.mcp, ID, path));
    return { doc, sourceFiles: [path], notes: [] };
  },

  async plan(doc, ctx): Promise<PlannedWrite> {
    const id = ctx.mode === "copy" ? `${doc.id.toLowerCase()}-copy` : ctx.targetNativeId ?? doc.id.toLowerCase();
    const mcp = mcpServersFromTools(doc.tools, { platformName: "JSON Agent", envExpansion: false });
    const body = {
      nomad_id: doc.id,
      name: doc.identity.name,
      system_prompt: [doc.identity.persona, ...doc.instructions.map((i) => i.content)].filter(Boolean).join("\n\n"),
      memories: doc.memory.map((m) => m.content),
      mcp: mcp.servers
    };
    const files: DesiredFile[] = [{ path: `agents/${id}.json`, content: JSON.stringify(body, null, 2) + "\n", strategy: "replace", component: "instructions", description: "Agent file", agentOwned: true }];
    return {
      nativeId: id,
      files,
      notes: [],
      manualSteps: mcp.manualSteps,
      conversions: doc.instructions.length > 1 ? [{ category: "instructions", item: `${doc.instructions.length} sections`, from: "instructions", to: "system_prompt" }] : [],
      unsupported: [
        ...doc.skills.map((s) => ({ category: "skills" as const, item: s.name, reason: "This format has no skills." })),
        ...doc.workflows.map((w) => ({ category: "workflows" as const, item: w.name, reason: "This format has no scheduler." })),
        ...(doc.permissions.rules.length ? [{ category: "permissions" as const, item: `${doc.permissions.rules.length} rule(s)`, reason: "This format has no permissions." }] : [])
      ]
    };
  },

  async verify(doc, root, nativeId) {
    const j = JSON.parse(readFileSync(join(root, "agents", `${nativeId}.json`), "utf8"));
    return [
      { name: "Identity kept", ok: j.nomad_id === doc.id },
      { name: "Memories written", ok: (j.memories ?? []).length === doc.memory.length }
    ];
  }
};
