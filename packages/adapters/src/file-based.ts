import { basename, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentDocument, Instruction, Tool } from "@nomad/schema";
import {
  createDocument,
  extractBlock,
  findAgentIdMarker,
  firstHeading,
  parseFrontmatter,
  removeBlocks,
  slugify,
  stringifyFrontmatter,
  type Adapter,
  type AdapterInfo,
  type AgentRef,
  type DesiredFile,
  type Note,
  type PlannedWrite,
  type VerifyCheck,
  type WriteContext
} from "@nomad/core";
import { isDirectory, isFile, listDir, pathExists, readTextIfExists } from "@nomad/core/node";
import {
  AIDER_INFO,
  CLINE_INFO,
  CONTINUE_INFO,
  CURSOR_INFO,
  GEMINI_CLI_INFO,
  GOOSE_INFO,
  OPENCODE_INFO,
  ROO_INFO,
  WINDSURF_INFO
} from "./catalog";
import {
  mcpServersFromTools,
  nomadBlockKey,
  parseAgentMarkdown,
  parseMemoryMarkdown,
  readSkillsTree,
  renderAgentMarkdown,
  safeName,
  skillToFiles,
  toolsFromMcpServers,
  wants,
  workflowManualSteps
} from "./util";

/**
 * Declarative adapters for platforms whose agent is a set of rules files plus an
 * optional MCP configuration file. Each spec states where things live; the
 * shared implementation reads, plans and verifies.
 */

type McpStyle = "claude" | "opencode" | "goose" | "continue";

interface McpSpec {
  path: (root: string) => Promise<string>;
  format: "json" | "yaml";
  style: McpStyle;
  writable: boolean;
  envExpansion: boolean;
  urlKey?: string;
}

interface WriteTarget {
  kind: "block" | "rule-file";
  /** Relative path of the block file, or of the rules folder. */
  path: (root: string) => Promise<string>;
  ext?: string;
  frontmatter?: (doc: AgentDocument) => Record<string, unknown>;
}

export interface FileAdapterSpec {
  info: AdapterInfo;
  detect: string[];
  /** Files read as instructions (relative to root). */
  instructionFiles: (root: string) => Promise<Array<{ path: string; kind: Instruction["kind"] }>>;
  /** Folders whose files are each an instruction. */
  rulesDirs?: (root: string) => Promise<Array<{ path: string; exts: string[] }>>;
  write: WriteTarget;
  mcp?: McpSpec;
  skillsDir?: (root: string) => Promise<string>;
  /** Extra structured writes (for example Aider's read list). */
  extra?: (doc: AgentDocument, ctx: WriteContext, targetPath: string) => Promise<DesiredFile[]>;
  /** Section of an instruction file the platform uses for its own memories. */
  memorySection?: RegExp;
  /** Multi agent folder (OpenCode agents). */
  agentsDir?: (root: string) => Promise<string>;
}

const at = (p: string) => async () => p;

async function readStructured(path: string, format: "json" | "yaml", notes: Note[]): Promise<any> {
  const text = await readTextIfExists(path);
  if (text === null) return undefined;
  try {
    return format === "json" ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    notes.push({ level: "warning", message: `Could not parse ${path}: ${(e as Error).message}` });
    return undefined;
  }
}

function toolsFromStyle(raw: any, style: McpStyle, platform: string, path: string): Tool[] {
  if (!raw) return [];
  switch (style) {
    case "claude":
      return toolsFromMcpServers(raw.mcpServers, platform, path);
    case "opencode": {
      const servers: Record<string, any> = {};
      for (const [name, s] of Object.entries((raw.mcp ?? {}) as Record<string, any>)) {
        if (s?.type === "remote") servers[name] = { url: s.url, headers: s.headers, enabled: s.enabled };
        else if (Array.isArray(s?.command)) servers[name] = { command: s.command[0], args: s.command.slice(1), env: s.environment, enabled: s.enabled };
      }
      return toolsFromMcpServers(servers, platform, path);
    }
    case "goose": {
      const servers: Record<string, any> = {};
      for (const [name, s] of Object.entries((raw.extensions ?? {}) as Record<string, any>)) {
        if (s?.type === "stdio") servers[name] = { command: s.cmd, args: s.args, env: s.envs, enabled: s.enabled };
        else if (s?.type === "sse" || s?.type === "streamable_http") servers[name] = { url: s.uri ?? s.url, type: s.type === "sse" ? "sse" : undefined, enabled: s.enabled };
      }
      return toolsFromMcpServers(servers, platform, path);
    }
    case "continue": {
      const servers: Record<string, any> = {};
      for (const s of Array.isArray(raw.mcpServers) ? raw.mcpServers : []) if (s?.name) servers[s.name] = s;
      return toolsFromMcpServers(servers, platform, path);
    }
  }
}

function patchForStyle(tools: Tool[], spec: McpSpec, platformName: string) {
  const r = mcpServersFromTools(tools, { platformName, envExpansion: spec.envExpansion, urlKey: spec.urlKey });
  switch (spec.style) {
    case "claude":
      return { patch: { mcpServers: r.servers }, steps: r.manualSteps };
    case "opencode": {
      const mcp: Record<string, unknown> = {};
      for (const [name, s] of Object.entries(r.servers) as Array<[string, any]>) {
        mcp[name] = s.command ? { type: "local", command: [s.command, ...(s.args ?? [])], ...(s.env ? { environment: s.env } : {}), enabled: true } : { type: "remote", url: s.url, ...(s.headers ? { headers: s.headers } : {}), enabled: true };
      }
      return { patch: { mcp }, steps: r.manualSteps };
    }
    case "goose": {
      const extensions: Record<string, unknown> = {};
      for (const [name, s] of Object.entries(r.servers) as Array<[string, any]>) {
        extensions[name] = s.command
          ? { name, type: "stdio", cmd: s.command, args: s.args ?? [], ...(s.env ? { envs: s.env } : {}), enabled: true, timeout: 300 }
          : { name, type: "streamable_http", uri: s.url, enabled: true, timeout: 300 };
      }
      return { patch: { extensions }, steps: r.manualSteps };
    }
    case "continue":
      return { patch: { mcpServers: Object.entries(r.servers).map(([name, s]) => ({ name, ...s })) }, steps: r.manualSteps };
  }
}

function parseInstructionText(text: string, kind: Instruction["kind"], id: string, path: string, platform: string, doc: AgentDocument, memorySection?: RegExp, prefer?: string) {
  const marker = findAgentIdMarker(text, prefer);
  // A file that belongs to another Nomad agent is not part of this one.
  if (marker && prefer && marker !== prefer && !text.includes(`agent=${prefer}`)) return;
  if (marker) {
    doc.id = marker;
    const block = extractBlock(text, `agent=${marker}`) ?? text;
    const parsed = parseAgentMarkdown(block, platform, path);
    const name = firstHeading(block);
    if (name) {
      doc.name = name;
      doc.identity.name = name;
    }
    if (parsed.persona) doc.identity.persona = parsed.persona;
    doc.instructions.push(...parsed.instructions);
    doc.memory.push(...parsed.memory);
  }
  let outside = parseFrontmatter(removeBlocks(text)).body.replace(/<!-- nomad:agent=[^>]*-->/g, "").trim();
  if (memorySection) {
    const m = memorySection.exec(outside);
    if (m) {
      const section = outside.slice(m.index);
      const end = section.slice(m[0].length).search(/\n## /);
      const body = end === -1 ? section : section.slice(0, m[0].length + end);
      doc.memory.push(...parseMemoryMarkdown(body, { platform, path, defaultKind: "fact", scope: "agent", idPrefix: `${platform}-memory` }));
      outside = outside.replace(body, "").trim();
    }
  }
  if (outside && !marker) doc.instructions.push({ id, kind, title: path, content: outside, source: { platform, path } });
  else if (outside) doc.instructions.unshift({ id, kind: "custom", title: path, content: outside, source: { platform, path } });
}

export function defineFileAdapter(spec: FileAdapterSpec): Adapter {
  const P = spec.info.id;
  const name = spec.info.displayName;

  async function targetPath(doc: AgentDocument, root: string): Promise<string> {
    const base = await spec.write.path(root);
    if (spec.write.kind === "block") return base;
    if (base && (await isFile(join(root, base)))) return base; // e.g. .clinerules is a single file
    return `${base}/nomad-${safeName(slugify(doc.name))}${spec.write.ext ?? ".md"}`;
  }

  const adapter: Adapter = {
    info: spec.info,

    async detect(root) {
      const evidence: string[] = [];
      for (const f of spec.detect) if (await pathExists(join(root, f))) evidence.push(f);
      return { detected: evidence.length > 0, confidence: evidence.length ? 0.6 : 0, evidence };
    },

    async discover(root) {
      const d = await adapter.detect(root);
      const refs: AgentRef[] = [];
      if (d.detected) refs.push({ nativeId: "main", name: `${name}: ${basename(root)}`, description: d.evidence.join(", "), location: root, kind: "main" });
      if (spec.agentsDir) {
        const dir = await spec.agentsDir(root);
        for (const e of await listDir(join(root, dir))) {
          if (!e.file || !e.name.endsWith(".md")) continue;
          const fm = parseFrontmatter((await readTextIfExists(join(root, dir, e.name))) ?? "");
          refs.push({ nativeId: `agent:${e.name.replace(/\.md$/, "")}`, name: e.name.replace(/\.md$/, ""), description: typeof fm.data.description === "string" ? fm.data.description : undefined, location: join(root, dir, e.name), kind: "subagent" });
        }
      }
      return refs;
    },

    async read(root, nativeId, options = {}) {
      const notes: Note[] = [];
      const sourceFiles: string[] = [];
      const doc = createDocument({ name: `${name}: ${basename(root)}`, platform: P });
      doc.source.location = root;
      doc.source.nativeId = nativeId;
      if (nativeId.startsWith("agent:") && spec.agentsDir) {
        const rel = `${await spec.agentsDir(root)}/${nativeId.slice(6)}.md`;
        const text = (await readTextIfExists(join(root, rel))) ?? "";
        sourceFiles.push(join(root, rel));
        const fm = parseFrontmatter(text);
        doc.name = nativeId.slice(6);
        doc.identity.name = doc.name;
        if (typeof fm.data.description === "string") doc.description = fm.data.description;
        if (typeof fm.data.model === "string") doc.models.preferred = fm.data.model;
        doc.extensions[`x-${P}`] = { frontmatter: fm.data };
        parseInstructionText(fm.body, "system", "prompt", rel, P, doc);
        return { doc, sourceFiles, notes };
      }
      for (const f of await spec.instructionFiles(root)) {
        const text = await readTextIfExists(join(root, f.path));
        if (text === null) continue;
        sourceFiles.push(join(root, f.path));
        parseInstructionText(text, f.kind, f.path.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase(), f.path, P, doc, spec.memorySection, options.agentId);
      }
      for (const dir of (await spec.rulesDirs?.(root)) ?? []) {
        if (!(await isDirectory(join(root, dir.path)))) continue;
        for (const e of await listDir(join(root, dir.path))) {
          if (!e.file || !dir.exts.some((x) => e.name.endsWith(x))) continue;
          const rel = `${dir.path}/${e.name}`;
          const text = (await readTextIfExists(join(root, rel)))!;
          sourceFiles.push(join(root, rel));
          const fm = parseFrontmatter(text);
          parseInstructionText(text, "custom", e.name.replace(/\.[^.]+$/, ""), rel, P, doc, undefined, options.agentId);
          const last = doc.instructions[doc.instructions.length - 1];
          if (last && Object.keys(fm.data).length) (last as any)[`x-${P}`] = { frontmatter: fm.data };
        }
      }
      if (spec.mcp) {
        const p = await spec.mcp.path(root);
        const raw = await readStructured(join(root, p), spec.mcp.format, notes);
        if (raw) {
          sourceFiles.push(join(root, p));
          doc.tools.push(...toolsFromStyle(raw, spec.mcp.style, P, p));
        }
      }
      if (spec.skillsDir) doc.skills.push(...(await readSkillsTree(join(root, await spec.skillsDir(root)), P, notes, 2)));
      return { doc, sourceFiles, notes };
    },

    async plan(doc, ctx) {
      const files: DesiredFile[] = [];
      const notes: Note[] = [];
      const manualSteps: string[] = [];
      const conversions: PlannedWrite["conversions"] = [];
      const unsupported: PlannedWrite["unsupported"] = [];
      let nativeId = "main";
      const body = renderAgentMarkdown(wants(ctx, "instructions") ? doc : { ...doc, instructions: [] }, { includeMemory: wants(ctx, "memory") });
      if ((ctx.mode === "copy" || ctx.targetNativeId?.startsWith("agent:")) && spec.agentsDir) {
        const stem = ctx.mode === "copy" ? safeName(slugify(ctx.targetName ?? doc.name)) : ctx.targetNativeId!.slice(6);
        nativeId = `agent:${stem}`;
        const ext = (doc.extensions[`x-${P}`] as any)?.frontmatter ?? {};
        files.push({ path: `${await spec.agentsDir(ctx.root)}/${stem}.md`, content: stringifyFrontmatter({ description: doc.description ?? doc.identity.description ?? doc.name, mode: "subagent", ...ext }, `<!-- nomad:agent=${doc.id} -->\n` + body), strategy: "replace", component: "instructions", description: `Agent definition ${stem}`, agentOwned: true });
      } else if (ctx.mode === "copy" && spec.write.kind === "block") {
        notes.push({ level: "error", message: `${name} holds one agent per location. Copy mode is not available; choose merge or replace, or pick another folder.` });
        return { nativeId, files: [], notes, manualSteps, conversions, unsupported };
      } else {
        const path = await targetPath(doc, ctx.root);
        if (spec.write.kind === "rule-file" && !(await isFile(join(ctx.root, await spec.write.path(ctx.root))))) {
          const fm = spec.write.frontmatter?.(doc) ?? {};
          files.push({ path, content: stringifyFrontmatter(fm, `<!-- nomad:agent=${doc.id} -->\n` + body), strategy: "replace", component: "instructions", description: `Rules file for ${doc.name}`, agentOwned: true });
        } else {
          files.push({ path, content: body, strategy: "managed-block", blockKey: nomadBlockKey(doc), component: "instructions", description: `Nomad section in ${path}` });
        }
        if (spec.extra) files.push(...(await spec.extra(doc, ctx, path)));
      }
      if (doc.identity.persona) conversions.push({ category: "identity", item: "persona", from: "persona", to: `Persona section in the ${name} rules` });
      if (wants(ctx, "memory") && doc.memory.length) conversions.push({ category: "memory", item: `${doc.memory.length} entries`, from: "structured memory", to: `Memory section in the ${name} rules` });

      if (wants(ctx, "skills") && doc.skills.length) {
        if (spec.skillsDir) {
          const dir = await spec.skillsDir(ctx.root);
          for (const s of doc.skills) {
            const { "x-claude-code-command": _c, "x-codex-prompt": _p, ...fm } = s.frontmatter;
            files.push(...skillToFiles({ ...s, frontmatter: fm }, dir));
          }
        } else {
          for (const s of doc.skills) unsupported.push({ category: "skills", item: s.name, reason: `${name} has no skill system.`, alternative: "The skill instructions are in the package and the report." });
        }
      }
      if (wants(ctx, "tools") && doc.tools.length) {
        const mcpTools = doc.tools.filter((t) => t.kind === "mcp" && t.mcp);
        if (spec.mcp?.writable && mcpTools.length && !nativeId.startsWith("agent:")) {
          const p = await spec.mcp.path(ctx.root);
          const { patch, steps } = patchForStyle(mcpTools, spec.mcp, name);
          files.push({ path: p, content: spec.mcp.format === "json" ? JSON.stringify(patch, null, 2) + "\n" : stringifyYaml(patch), strategy: spec.mcp.format === "json" ? "merge-json" : "merge-yaml", arrayKeys: spec.mcp.style === "continue" ? { mcpServers: "name" } : undefined, component: "tools", description: `${mcpTools.length} MCP server(s) in ${p}` });
          manualSteps.push(...steps);
        } else {
          for (const t of doc.tools) {
            unsupported.push({ category: "tools", item: t.name, reason: `Nomad cannot configure tools for ${name} here.`, alternative: "Add the server in the application settings. Its definition is in the report." });
          }
        }
      }
      if (wants(ctx, "permissions") && doc.permissions.rules.length) {
        unsupported.push({ category: "permissions", item: `${doc.permissions.rules.length} rule(s)`, reason: `${name} permissions are configured in the application.`, alternative: "Rules are documented in the report." });
      }
      if (wants(ctx, "models") && doc.models.preferred) manualSteps.push(`Select ${doc.models.preferred} (or the closest available model) in ${name}.`);
      if (wants(ctx, "workflows") && doc.workflows.length) {
        for (const w of doc.workflows) unsupported.push({ category: "workflows", item: w.name, reason: `${name} has no scheduler.` });
        manualSteps.push(...workflowManualSteps(doc, name));
      }
      if (wants(ctx, "integrations")) for (const i of doc.integrations) manualSteps.push(`Reconnect ${i.name} in ${name}.`);
      if (wants(ctx, "knowledge") && (doc.knowledge.length || doc.files.length)) manualSteps.push(`Copy ${doc.knowledge.length + doc.files.length} knowledge file(s) into the project.`);
      notes.push({ level: "info", message: `${name} support is experimental. Open the project in ${name} after migrating to confirm the rules load.` });
      return { nativeId, files, notes, manualSteps, conversions, unsupported };
    },

    async verify(doc, root, nativeId, ctx) {
      const checks: VerifyCheck[] = [];
      const got = (await adapter.read!(root, nativeId, { agentId: doc.id })).doc;
      checks.push({ name: "Agent identity marker present", ok: got.id === doc.id });
      if (wants(ctx, "instructions")) {
        const missing = doc.instructions.filter((i) => i.content.trim() && !got.instructions.some((g) => g.content.trim() === i.content.trim()));
        checks.push({ name: "Instructions preserved", ok: !missing.length, detail: missing.length ? `Missing: ${missing.map((m) => m.id).join(", ")}` : undefined });
      }
      if (wants(ctx, "memory") && doc.memory.length) {
        const ids = new Set(got.memory.map((m) => m.id));
        const missing = doc.memory.filter((m) => !ids.has(m.id)).length;
        checks.push({ name: "Memory transferred", ok: missing === 0, detail: missing ? `${missing} entries missing` : undefined });
      }
      if (spec.mcp?.writable && wants(ctx, "tools") && doc.tools.some((t) => t.kind === "mcp") && !nativeId.startsWith("agent:")) {
        const names = new Set(got.tools.map((t) => t.name));
        const missing = doc.tools.filter((t) => t.kind === "mcp" && !names.has(t.name));
        checks.push({ name: "MCP servers configured", ok: !missing.length, detail: missing.length ? `Missing: ${missing.map((t) => t.name).join(", ")}` : undefined });
      }
      return checks;
    }
  };
  return adapter;
}

const isHomeDir = (root: string, name: string) => basename(root) === name;

export const cursorAdapter = defineFileAdapter({
  info: CURSOR_INFO,
  detect: [".cursor", ".cursorrules"],
  instructionFiles: async () => [
    { path: ".cursorrules", kind: "custom" },
    { path: "AGENTS.md", kind: "agent" }
  ],
  rulesDirs: async () => [{ path: ".cursor/rules", exts: [".mdc", ".md"] }],
  write: { kind: "rule-file", path: at(".cursor/rules"), ext: ".mdc", frontmatter: (doc) => ({ description: doc.description ?? `${doc.name} agent instructions (Nomad)`, alwaysApply: true }) },
  mcp: { path: at(".cursor/mcp.json"), format: "json", style: "claude", writable: true, envExpansion: true }
});

export const windsurfAdapter = defineFileAdapter({
  info: WINDSURF_INFO,
  detect: [".windsurf", ".windsurfrules"],
  instructionFiles: async () => [{ path: ".windsurfrules", kind: "custom" }],
  rulesDirs: async () => [{ path: ".windsurf/rules", exts: [".md"] }],
  write: { kind: "rule-file", path: at(".windsurf/rules"), ext: ".md", frontmatter: () => ({ trigger: "always_on" }) }
});

export const clineAdapter = defineFileAdapter({
  info: CLINE_INFO,
  detect: [".clinerules"],
  instructionFiles: async (root) => ((await isFile(join(root, ".clinerules"))) ? [{ path: ".clinerules", kind: "custom" }] : []),
  rulesDirs: async () => [{ path: ".clinerules", exts: [".md", ".txt"] }],
  write: { kind: "rule-file", path: at(".clinerules"), ext: ".md" }
});

export const rooAdapter = defineFileAdapter({
  info: ROO_INFO,
  detect: [".roo", ".roorules", ".roomodes"],
  instructionFiles: async () => [{ path: ".roorules", kind: "custom" }],
  rulesDirs: async () => [{ path: ".roo/rules", exts: [".md", ".txt"] }],
  write: { kind: "rule-file", path: at(".roo/rules"), ext: ".md" },
  mcp: { path: at(".roo/mcp.json"), format: "json", style: "claude", writable: true, envExpansion: false }
});

export const continueAdapter = defineFileAdapter({
  info: CONTINUE_INFO,
  detect: [".continue", "config.yaml", "rules"],
  instructionFiles: async () => [],
  rulesDirs: async (root) => [{ path: isHomeDir(root, ".continue") ? "rules" : ".continue/rules", exts: [".md"] }],
  write: { kind: "rule-file", path: async (root) => (isHomeDir(root, ".continue") ? "rules" : ".continue/rules"), ext: ".md", frontmatter: (doc) => ({ name: doc.name, alwaysApply: true }) },
  mcp: { path: async (root) => (isHomeDir(root, ".continue") ? "config.yaml" : ".continue/config.yaml"), format: "yaml", style: "continue", writable: false, envExpansion: false }
});

export const opencodeAdapter = defineFileAdapter({
  info: OPENCODE_INFO,
  detect: ["opencode.json", ".opencode", "AGENTS.md"],
  instructionFiles: async () => [{ path: "AGENTS.md", kind: "agent" }],
  write: { kind: "block", path: at("AGENTS.md") },
  mcp: { path: at("opencode.json"), format: "json", style: "opencode", writable: true, envExpansion: false },
  agentsDir: async (root) => (isHomeDir(root, "opencode") ? "agent" : ".opencode/agent"),
  skillsDir: async (root) => (isHomeDir(root, "opencode") ? "skill" : ".opencode/skill")
});

export const gooseAdapter = defineFileAdapter({
  info: GOOSE_INFO,
  detect: [".goosehints", "config.yaml"],
  instructionFiles: async () => [{ path: ".goosehints", kind: "agent" }],
  write: { kind: "block", path: at(".goosehints") },
  mcp: { path: at("config.yaml"), format: "yaml", style: "goose", writable: true, envExpansion: false }
});

export const aiderAdapter = defineFileAdapter({
  info: AIDER_INFO,
  detect: [".aider.conf.yml", "CONVENTIONS.md"],
  instructionFiles: async () => [{ path: "CONVENTIONS.md", kind: "conventions" }],
  write: { kind: "block", path: at("CONVENTIONS.md") },
  extra: async (_doc, _ctx, target) => [
    { path: ".aider.conf.yml", content: stringifyYaml({ read: [target] }), strategy: "merge-yaml", component: "instructions", description: "Load CONVENTIONS.md through the Aider read list" }
  ]
});

export const geminiCliAdapter = defineFileAdapter({
  info: GEMINI_CLI_INFO,
  detect: ["GEMINI.md", "settings.json", ".gemini"],
  instructionFiles: async () => [{ path: "GEMINI.md", kind: "agent" }],
  write: { kind: "block", path: at("GEMINI.md") },
  memorySection: /## Gemini Added Memories/,
  mcp: { path: async (root) => (isHomeDir(root, ".gemini") ? "settings.json" : ".gemini/settings.json"), format: "json", style: "claude", writable: true, envExpansion: true, urlKey: "httpUrl" },
  skillsDir: undefined
});

export const FILE_ADAPTERS = [cursorAdapter, windsurfAdapter, clineAdapter, rooAdapter, continueAdapter, opencodeAdapter, gooseAdapter, aiderAdapter, geminiCliAdapter];
