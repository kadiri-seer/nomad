import { basename, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { AgentDocument, PermissionPolicy, PermissionRule, Skill } from "@nomad/schema";
import {
  createDocument,
  extractBlock,
  findAgentIdMarker,
  firstHeading,
  parseFrontmatter,
  removeBlocks,
  stringifyFrontmatter,
  type Adapter,
  type DesiredFile,
  type Note,
  type PlannedWrite,
  type VerifyCheck
} from "@nomad/core";
import { listDir, pathExists, readTextIfExists } from "@nomad/core/node";
import { CODEX_INFO } from "./catalog";
import {
  bareModel,
  blanketEffect,
  mcpServersFromTools,
  modelFamily,
  nomadBlockKey,
  parseAgentMarkdown,
  readSkillsTree,
  renderAgentMarkdown,
  rule,
  safeName,
  skillToFiles,
  toolsFromMcpServers,
  wants,
  workflowManualSteps
} from "./util";

const P = "codex";

async function layoutOf(root: string) {
  const user = basename(root) === ".codex" || (await pathExists(join(root, "config.toml")));
  return user
    ? { user, agentsMd: "AGENTS.md", config: "config.toml", skills: "skills", prompts: "prompts" }
    : { user, agentsMd: "AGENTS.md", config: ".codex/config.toml", skills: ".codex/skills", prompts: ".codex/prompts" };
}

async function readConfig(path: string, notes: Note[]): Promise<Record<string, any> | undefined> {
  const text = await readTextIfExists(path);
  if (text === null) return undefined;
  try {
    return parseToml(text) as Record<string, any>;
  } catch (e) {
    notes.push({ level: "warning", message: `Could not parse ${path}: ${(e as Error).message}` });
    return undefined;
  }
}

export function policyFromCodexConfig(cfg: Record<string, any>): PermissionPolicy {
  const rules: PermissionRule[] = [];
  const notes: string[] = [];
  let mode: PermissionPolicy["mode"] = "ask";
  const sandbox = cfg.sandbox_mode as string | undefined;
  const approval = cfg.approval_policy as string | undefined;
  if (sandbox === "read-only") {
    mode = "read-only";
    rules.push(rule("write", "deny", undefined, "codex:sandbox_mode=read-only"));
  } else if (sandbox === "workspace-write") {
    rules.push(rule("write", "allow", "workspace", "codex:sandbox_mode=workspace-write"));
  } else if (sandbox === "danger-full-access") {
    rules.push(rule("write", "allow", undefined, "codex:sandbox_mode=danger-full-access"));
    rules.push(rule("network", "allow", undefined, "codex:sandbox_mode=danger-full-access"));
  }
  const net = cfg.sandbox_workspace_write?.network_access;
  if (sandbox !== "danger-full-access") {
    if (net === true) rules.push(rule("network", "allow", undefined, "codex:network_access=true"));
    else rules.push(rule("network", "deny", undefined, "codex:network_access=false"));
  }
  if (approval === "never") {
    if (mode !== "read-only") mode = "auto";
    rules.push(rule("shell", "allow", undefined, "codex:approval_policy=never"));
  } else if (approval) {
    rules.push(rule("shell", "ask", undefined, `codex:approval_policy=${approval}`));
  }
  if (sandbox) notes.push(`Codex sandbox_mode: ${sandbox}`);
  if (approval) notes.push(`Codex approval_policy: ${approval}`);
  return { mode, rules, notes };
}

/** Map a policy onto Codex settings. Always chooses the safer setting when the mapping is not exact. */
export function codexSettingsFromPolicy(policy: PermissionPolicy) {
  const settings: Record<string, any> = {};
  const unenforced: string[] = [];
  const write = blanketEffect(policy.rules, "write");
  const shell = blanketEffect(policy.rules, "shell");
  const network = blanketEffect(policy.rules, "network");
  if (policy.mode === "read-only" || write === "deny") settings.sandbox_mode = "read-only";
  else settings.sandbox_mode = "workspace-write";
  if (settings.sandbox_mode === "workspace-write") {
    if (network === "allow") settings.sandbox_workspace_write = { network_access: true };
    else settings.sandbox_workspace_write = { network_access: false };
  }
  if (shell === "deny") {
    settings.approval_policy = "untrusted";
    unenforced.push("deny shell (Codex can only ask before commands, it cannot block them all)");
  } else if (shell === "allow" && policy.mode === "auto") settings.approval_policy = "on-request";
  else settings.approval_policy = "on-request";
  for (const r of policy.rules) {
    if (r.source?.startsWith("codex:")) continue;
    if (r.pattern) unenforced.push(`${r.effect} ${r.capability} (${r.pattern})`);
    else if (["browser", "computer", "schedule", "integration", "tool"].includes(r.capability)) unenforced.push(`${r.effect} ${r.capability}`);
  }
  return { settings, unenforced };
}

export const codexAdapter: Adapter = {
  info: CODEX_INFO,

  async detect(root) {
    const evidence: string[] = [];
    for (const f of ["config.toml", "AGENTS.md", "skills", "prompts", ".codex"]) if (await pathExists(join(root, f))) evidence.push(f);
    const strong = basename(root) === ".codex" || evidence.includes("config.toml") || evidence.includes(".codex");
    return { detected: strong, confidence: strong ? 0.9 : 0, evidence };
  },

  async discover(root) {
    const L = await layoutOf(root);
    const md = await readTextIfExists(join(root, L.agentsMd));
    if (md === null && !(await pathExists(join(root, L.config)))) return [];
    const id = md ? findAgentIdMarker(md) : null;
    const name = (id && firstHeading(extractBlock(md!, `agent=${id}`) ?? "")) || (L.user ? "Codex (user)" : `Codex: ${basename(root)}`);
    return [{ nativeId: "main", name, description: "AGENTS.md, config.toml and skills", location: root, kind: "main" }];
  },

  async read(root) {
    const L = await layoutOf(root);
    const notes: Note[] = [];
    const sourceFiles: string[] = [];
    const doc = createDocument({ name: L.user ? "Codex (user)" : `Codex: ${basename(root)}`, platform: P });
    doc.source.location = root;
    doc.source.nativeId = "main";
    const mdPath = join(root, L.agentsMd);
    const md = await readTextIfExists(mdPath);
    if (md !== null) {
      sourceFiles.push(mdPath);
      const id = findAgentIdMarker(md);
      if (id) {
        doc.id = id;
        const block = extractBlock(md, `agent=${id}`) ?? "";
        const parsed = parseAgentMarkdown(block, P, L.agentsMd);
        const name = firstHeading(block);
        if (name) {
          doc.name = name;
          doc.identity.name = name;
        }
        if (parsed.persona) doc.identity.persona = parsed.persona;
        if (parsed.tone) doc.identity.tone = parsed.tone;
        doc.instructions.push(...parsed.instructions);
        doc.memory.push(...parsed.memory);
      }
      const outside = removeBlocks(md).trim();
      if (outside) doc.instructions.unshift({ id: "agents-md", kind: "agent", title: "AGENTS.md", content: outside, source: { platform: P, path: L.agentsMd } });
    }
    const cfgPath = join(root, L.config);
    const cfg = await readConfig(cfgPath, notes);
    if (cfg) {
      sourceFiles.push(cfgPath);
      if (typeof cfg.model === "string") doc.models.preferred = cfg.model;
      if (typeof cfg.model_provider === "string") doc.models.provider = cfg.model_provider;
      if (typeof cfg.model_reasoning_effort === "string") doc.models.reasoningEffort = cfg.model_reasoning_effort;
      doc.permissions = policyFromCodexConfig(cfg);
      if (cfg.mcp_servers) {
        const servers: Record<string, any> = {};
        for (const [name, s] of Object.entries(cfg.mcp_servers as Record<string, any>)) servers[name] = { ...s, headers: s.http_headers };
        doc.tools.push(...toolsFromMcpServers(servers, P, L.config));
      }
      if (cfg.profiles) doc.extensions["x-codex"] = { profiles: cfg.profiles };
    }
    doc.skills.push(...(await readSkillsTree(join(root, L.skills), P, notes, 1)));
    for (const e of await listDir(join(root, L.prompts))) {
      if (!e.file || !e.name.endsWith(".md")) continue;
      const text = (await readTextIfExists(join(root, L.prompts, e.name)))!;
      sourceFiles.push(join(root, L.prompts, e.name));
      const fm = parseFrontmatter(text);
      const skill: Skill = {
        name: e.name.replace(/\.md$/, ""),
        description: typeof fm.data.description === "string" ? fm.data.description : `Custom prompt /${e.name.replace(/\.md$/, "")}`,
        instructions: fm.body.trim(),
        dependencies: [],
        platforms: [],
        allowedTools: [],
        config: {},
        references: [],
        files: [],
        frontmatter: { ...fm.data, "x-codex-prompt": true },
        invocation: "manual",
        source: { platform: P, path: `${L.prompts}/${e.name}` }
      };
      delete (skill.frontmatter as any).description;
      doc.skills.push(skill);
    }
    return { doc, sourceFiles, notes };
  },

  async plan(doc, ctx) {
    const L = await layoutOf(ctx.root);
    const files: DesiredFile[] = [];
    const notes: Note[] = [];
    const manualSteps: string[] = [];
    const conversions: PlannedWrite["conversions"] = [];
    const unsupported: PlannedWrite["unsupported"] = [];
    if (ctx.mode === "copy") {
      notes.push({ level: "error", message: "Codex holds one agent per home directory. Copy mode is not available; choose merge or replace, or pick another directory." });
      return { nativeId: "main", files: [], notes, manualSteps, conversions, unsupported };
    }
    const body = renderAgentMarkdown(wants(ctx, "instructions") ? doc : { ...doc, instructions: [] }, { includeMemory: wants(ctx, "memory") });
    files.push({ path: L.agentsMd, content: body, strategy: "managed-block", blockKey: nomadBlockKey(doc), component: "instructions", description: "Agent persona, instructions and memory in a Nomad managed section of AGENTS.md" });
    if (doc.identity.persona) conversions.push({ category: "identity", item: "persona", from: "persona", to: "Persona section in AGENTS.md" });
    if (wants(ctx, "memory") && doc.memory.length) conversions.push({ category: "memory", item: `${doc.memory.length} entries`, from: "structured memory", to: "Memory section in AGENTS.md" });

    if (wants(ctx, "skills")) {
      for (const s of doc.skills) {
        const isCommand = s.frontmatter["x-codex-prompt"] === true || s.frontmatter["x-claude-code-command"] === true;
        const { "x-codex-prompt": _p, "x-claude-code-command": _c, ...fm } = s.frontmatter;
        if (isCommand) {
          if (_c) conversions.push({ category: "skills", item: s.name, from: "Claude Code slash command", to: "Codex custom prompt" });
          const { "allowed-tools": _a, "argument-hint": hint, model: _m, ...rest } = fm as Record<string, unknown>;
          files.push({
            path: `${L.prompts}/${safeName(s.name)}.md`,
            content: stringifyFrontmatter({ description: s.description, ...(hint ? { "argument-hint": hint } : {}), ...rest }, s.instructions.replace(/\$ARGUMENTS/g, "$ARGUMENTS")),
            strategy: "replace",
            component: "skills",
            description: `Custom prompt /${s.name}`,
            agentOwned: true
          });
        } else files.push(...skillToFiles({ ...s, frontmatter: fm }, L.skills));
      }
      if (!L.user && doc.skills.length) notes.push({ level: "info", category: "skills", message: "Repository skills are written to .codex/skills. Check that your Codex version loads repository skills." });
    }

    const config: Record<string, any> = {};
    if (wants(ctx, "models") && doc.models.preferred) {
      if (modelFamily(doc.models.preferred) === "openai") {
        config.model = bareModel(doc.models.preferred);
        if (doc.models.reasoningEffort) config.model_reasoning_effort = doc.models.reasoningEffort;
      } else unsupported.push({ category: "models", item: doc.models.preferred, reason: "Codex is configured for OpenAI models here.", alternative: "Configure a model_provider in config.toml if you use another provider." });
    }
    if (wants(ctx, "permissions")) {
      const p = codexSettingsFromPolicy(doc.permissions);
      Object.assign(config, p.settings);
      for (const u of p.unenforced) unsupported.push({ category: "permissions", item: u, reason: "Codex has no rule for this.", alternative: "Documented in the report." });
      conversions.push({ category: "permissions", item: "policy", from: "permission rules", to: `approval_policy=${p.settings.approval_policy}, sandbox_mode=${p.settings.sandbox_mode}` });
    }
    if (wants(ctx, "tools")) {
      const mcpTools = doc.tools.filter((t) => t.kind === "mcp" && t.mcp);
      if (mcpTools.length) {
        const r = mcpServersFromTools(mcpTools, { platformName: "Codex", envExpansion: false });
        const servers: Record<string, any> = {};
        for (const [name, s] of Object.entries(r.servers)) {
          const { headers, ...rest } = s as Record<string, unknown>;
          servers[name] = { ...rest, ...(headers ? { http_headers: headers } : {}) };
        }
        config.mcp_servers = servers;
        manualSteps.push(...r.manualSteps);
      }
      for (const t of doc.tools.filter((t) => t.kind !== "mcp")) unsupported.push({ category: "tools", item: t.name, reason: "Only MCP servers can be configured in Codex." });
    }
    if (Object.keys(config).length) {
      if (!L.user) notes.push({ level: "info", message: "Settings are written to .codex/config.toml in the project." });
      files.push({ path: L.config, content: stringifyToml(config) + "\n", strategy: "merge-toml", component: "permissions", description: "Model, approvals, sandbox and MCP servers in config.toml" });
    }
    if (wants(ctx, "workflows") && doc.workflows.length) {
      for (const w of doc.workflows) unsupported.push({ category: "workflows", item: w.name, reason: "Codex has no scheduler." });
      manualSteps.push(...workflowManualSteps(doc, "Codex"));
    }
    if (wants(ctx, "integrations")) for (const i of doc.integrations) manualSteps.push(`Reconnect the ${i.name} integration for Codex.`);
    if (wants(ctx, "knowledge") && (doc.knowledge.length || doc.files.length)) manualSteps.push(`Copy ${doc.knowledge.length + doc.files.length} knowledge file(s) into the project and mention them in AGENTS.md.`);
    return { nativeId: "main", files, notes, manualSteps, conversions, unsupported };
  },

  async readPolicy(root) {
    const L = await layoutOf(root);
    const cfg = (await readConfig(join(root, L.config), [])) ?? {};
    // Codex defaults when config.toml does not say otherwise.
    return policyFromCodexConfig({ sandbox_mode: "workspace-write", approval_policy: "on-request", ...cfg });
  },

  async verify(doc, root, nativeId, ctx) {
    const checks: VerifyCheck[] = [];
    const L = await layoutOf(root);
    const notes: Note[] = [];
    const cfgText = await readTextIfExists(join(root, L.config));
    if (cfgText !== null) {
      const cfg = await readConfig(join(root, L.config), notes);
      checks.push({ name: "config.toml parses", ok: !!cfg, detail: notes[0]?.message });
    }
    const got = (await this.read!(root, nativeId)).doc;
    checks.push({ name: "Agent identity marker present", ok: got.id === doc.id });
    if (wants(ctx, "instructions")) {
      const missing = doc.instructions.filter((i) => i.content.trim() && !got.instructions.some((g) => g.content.trim() === i.content.trim()));
      checks.push({ name: "Instructions preserved", ok: !missing.length, detail: missing.length ? `Missing: ${missing.map((m) => m.id).join(", ")}` : undefined });
    }
    if (wants(ctx, "memory") && doc.memory.length) {
      const ids = new Set(got.memory.map((m) => m.id));
      const missing = doc.memory.filter((m) => !ids.has(m.id)).length;
      checks.push({ name: "Memory transferred", ok: missing === 0, detail: missing ? `${missing} entries missing` : `${doc.memory.length} entries` });
    }
    if (wants(ctx, "skills") && doc.skills.length) {
      const names = new Set(got.skills.map((s) => s.name));
      const missing = doc.skills.filter((s) => !names.has(s.name) && !names.has(safeName(s.name)));
      checks.push({ name: "Skills written", ok: !missing.length, detail: missing.length ? `Missing: ${missing.map((s) => s.name).join(", ")}` : undefined });
    }
    if (wants(ctx, "tools") && doc.tools.some((t) => t.kind === "mcp")) {
      const names = new Set(got.tools.map((t) => t.name));
      const missing = doc.tools.filter((t) => t.kind === "mcp" && !names.has(t.name));
      checks.push({ name: "MCP servers configured", ok: !missing.length, detail: missing.length ? `Missing: ${missing.map((t) => t.name).join(", ")}` : undefined });
    }
    return checks;
  }
};

export type { AgentDocument };
