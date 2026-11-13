import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { AgentDocument, PermissionPolicy, PermissionRule, Capability, Skill, Tool, Integration } from "@nomad/schema";
import {
  createDocument,
  extractBlock,
  findAgentIdMarker,
  firstHeading,
  parseFrontmatter,
  removeBlocks,
  stringifyFrontmatter,
  slugify,
  type Adapter,
  type AgentRef,
  type DesiredFile,
  type Note,
  type PlannedWrite,
  type VerifyCheck,
  type WriteContext
} from "@nomad/core";
import { isDirectory, listDir, pathExists, readTextIfExists } from "@nomad/core/node";
import { CLAUDE_CODE_INFO } from "./catalog";
import {
  bareModel,
  blanketEffect,
  mcpServersFromTools,
  modelFamily,
  nomadBlockKey,
  parseAgentMarkdown,
  parseMemoryMarkdown,
  readSkillsTree,
  readSkillDir,
  renderAgentMarkdown,
  renderMemoryMarkdown,
  rule,
  safeName,
  skillToFiles,
  toolsFromMcpServers,
  pluginOf,
  wants,
  workflowManualSteps
} from "./util";

const P = "claude-code";

interface Layout {
  user: boolean;
  root: string;
  base: string; // "" for ~/.claude, ".claude/" for projects
  claudeMd: string;
  settings: string;
  mcpRoot: string;
  mcpPath: string;
}

async function layoutOf(root: string): Promise<Layout> {
  const user =
    basename(root) === ".claude" ||
    (!(await pathExists(join(root, ".claude"))) && ((await pathExists(join(root, "settings.json"))) || (await isDirectory(join(root, "agents")))));
  if (user) {
    return { user, root, base: "", claudeMd: "CLAUDE.md", settings: "settings.json", mcpRoot: dirname(root), mcpPath: ".claude.json" };
  }
  return { user, root, base: ".claude/", claudeMd: "CLAUDE.md", settings: ".claude/settings.json", mcpRoot: root, mcpPath: ".mcp.json" };
}

async function readJson(path: string, notes: Note[]): Promise<any> {
  const text = await readTextIfExists(path);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    notes.push({ level: "warning", message: `Could not parse ${path}: ${(e as Error).message}` });
    return undefined;
  }
}

/* ------------------------------ permissions ------------------------------ */

const TOOL_CAP: Record<string, Capability> = {
  Bash: "shell",
  Read: "read",
  Glob: "read",
  Grep: "read",
  LS: "read",
  Edit: "write",
  Write: "write",
  MultiEdit: "write",
  NotebookEdit: "write",
  WebFetch: "network",
  WebSearch: "network",
  Task: "tool"
};

function parseClaudeRule(s: string, effect: PermissionRule["effect"]): PermissionRule {
  const m = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/.exec(s.trim());
  if (!m) return rule("tool", effect, s, `claude-code:${s}`);
  const [, tool, pattern] = m;
  if (tool.startsWith("mcp__")) return rule("tool", effect, tool, `claude-code:${s}`);
  return rule(TOOL_CAP[tool] ?? "tool", effect, pattern || (TOOL_CAP[tool] ? undefined : tool), `claude-code:${s}`);
}

export function policyFromSettings(settings: any): PermissionPolicy {
  const perms = settings?.permissions ?? {};
  const rules: PermissionRule[] = [];
  for (const effect of ["allow", "ask", "deny"] as const) {
    for (const s of Array.isArray(perms[effect]) ? perms[effect] : []) if (typeof s === "string") rules.push(parseClaudeRule(s, effect));
  }
  const notes: string[] = [];
  let mode: PermissionPolicy["mode"] = "ask";
  switch (perms.defaultMode) {
    case "plan":
      mode = "read-only";
      break;
    case "bypassPermissions":
    case "dontAsk":
      mode = "auto";
      break;
    case "acceptEdits":
      rules.push(rule("write", "allow", undefined, "claude-code:defaultMode=acceptEdits"));
      break;
  }
  if (perms.defaultMode) notes.push(`Claude Code defaultMode: ${perms.defaultMode}`);
  if (Array.isArray(perms.additionalDirectories) && perms.additionalDirectories.length) {
    for (const d of perms.additionalDirectories) rules.push(rule("file", "allow", String(d), "claude-code:additionalDirectories"));
  }
  return { mode, rules, notes };
}

function claudeRuleStrings(r: PermissionRule): string[] | null {
  if (r.source?.startsWith("claude-code:") && !r.source.includes("defaultMode") && !r.source.includes("additionalDirectories") && !r.source.includes("subagent-tools")) {
    return [r.source.slice("claude-code:".length)];
  }
  const p = r.pattern;
  switch (r.capability) {
    case "shell":
      return [p ? `Bash(${p})` : "Bash"];
    case "read":
      return [p ? `Read(${p})` : "Read"];
    case "write":
      return [p ? `Edit(${p})` : "Edit"];
    case "file":
      return p ? [`Read(${p})`, `Edit(${p})`] : ["Read", "Edit"];
    case "network":
      if (!p) return ["WebFetch", "WebSearch"];
      return [p.includes(":") ? `WebFetch(${p})` : `WebFetch(domain:${p})`];
    case "tool":
      if (p && (p.startsWith("mcp__") || /^[A-Z]\w+$/.test(p))) return [p];
      return null;
    default:
      return null;
  }
}

function settingsFromPolicy(policy: PermissionPolicy): { permissions: Record<string, unknown>; unenforced: string[]; notes: string[] } {
  const permissions: Record<string, string[] | string> = {};
  const unenforced: string[] = [];
  const notes: string[] = [];
  for (const effect of ["allow", "ask", "deny"] as const) {
    const list: string[] = [];
    for (const r of policy.rules.filter((x) => x.effect === effect)) {
      if (r.source === "claude-code:defaultMode=acceptEdits" || r.source === "claude-code:subagent-tools") continue;
      if (r.source === "claude-code:additionalDirectories") continue;
      const s = claudeRuleStrings(r);
      if (s) list.push(...s.filter((x) => !list.includes(x)));
      else unenforced.push(`${effect} ${r.capability}${r.pattern ? ` (${r.pattern})` : ""}`);
    }
    if (list.length) permissions[effect] = list;
  }
  const dirs = policy.rules.filter((r) => r.source === "claude-code:additionalDirectories" && r.effect === "allow").map((r) => r.pattern!);
  if (dirs.length) permissions.additionalDirectories = dirs;
  if (policy.mode === "read-only") permissions.defaultMode = "plan";
  else if (policy.mode === "auto" || policy.rules.some((r) => r.source === "claude-code:defaultMode=acceptEdits")) {
    permissions.defaultMode = "acceptEdits";
    if (policy.mode === "auto") notes.push("The source ran without approval prompts. Claude Code is set to acceptEdits, which still asks before shell commands.");
  }
  return { permissions, unenforced, notes };
}

/* ------------------------------ subagents ------------------------------ */

const SUBAGENT_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch", "WebSearch"];

function subagentRestrictions(tools: string[]): PermissionRule[] {
  const caps = new Set(tools.map((t) => TOOL_CAP[t] ?? "tool"));
  const rules: PermissionRule[] = tools.map((t) => rule(TOOL_CAP[t] ?? "tool", "allow", TOOL_CAP[t] ? undefined : t, `claude-code:${t}`));
  for (const c of ["shell", "write", "network"] as const) if (!caps.has(c)) rules.push(rule(c, "deny", undefined, "claude-code:subagent-tools"));
  return rules;
}

function toolsForSubagent(doc: AgentDocument): string[] | undefined {
  const ext = doc.extensions["x-claude-code"] as any;
  if (Array.isArray(ext?.tools)) return ext.tools;
  const denied = new Set(doc.permissions.rules.filter((r) => r.effect === "deny" && !r.pattern).map((r) => r.capability));
  if (doc.permissions.mode === "read-only") denied.add("write"), denied.add("shell");
  const tools = SUBAGENT_TOOLS.filter((t) => !denied.has(TOOL_CAP[t]));
  // No restriction that subagent tools can express: inherit, as Claude Code does by default.
  return tools.length === SUBAGENT_TOOLS.length ? undefined : tools;
}

function subagentModel(doc: AgentDocument): string | undefined {
  const m = doc.models.preferred;
  if (!m || modelFamily(m) !== "anthropic") return undefined;
  const lower = m.toLowerCase();
  if (["opus", "sonnet", "haiku", "inherit"].includes(lower)) return lower;
  for (const a of ["opus", "sonnet", "haiku"]) if (lower.includes(a)) return a;
  return undefined;
}

/* ------------------------------ adapter ------------------------------ */

/**
 * Enabled Claude Code plugins at the user level: enabledPlugins in
 * settings.json says which are on, installed_plugins.json says where they are.
 * Their servers and skills are read; plugins are never installed by Nomad.
 */
async function readInstalledPlugins(root: string, settings: any, notes: Note[]): Promise<{ tools: Tool[]; skills: Skill[]; integrations: Integration[]; sourceFiles: string[] }> {
  const out = { tools: [] as Tool[], skills: [] as Skill[], integrations: [] as Integration[], sourceFiles: [] as string[] };
  const enabled = Object.entries((settings?.enabledPlugins ?? {}) as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k);
  if (!enabled.length) return out;
  const pluginsRoot = join(root, "plugins");
  const roots = [pluginsRoot, process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR].filter((x): x is string => !!x).map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  const installedPath = join(pluginsRoot, "installed_plugins.json");
  const installed = await readJson(installedPath, notes);
  if (installed) out.sourceFiles.push(installedPath);
  // Accept a flat map or a { plugins: {...} } wrapper.
  const map: Record<string, unknown> = installed?.plugins && typeof installed.plugins === "object" && !Array.isArray(installed.plugins) ? installed.plugins : (installed ?? {});
  const marketplaces = (await readJson(join(pluginsRoot, "known_marketplaces.json"), [])) ?? {};
  for (const id of enabled) {
    const raw = map[id];
    const entry = (Array.isArray(raw) ? raw.find((e: any) => e?.scope === "user") ?? raw[0] : raw) as { installPath?: unknown; version?: unknown } | undefined;
    if (!entry || typeof entry.installPath !== "string") {
      notes.push({ level: "warning", category: "integrations", message: `Plugin ${id} is enabled but its install location was not found, so it was not read.` });
      continue;
    }
    let dir: string;
    try {
      dir = realpathSync(entry.installPath);
    } catch {
      notes.push({ level: "warning", category: "integrations", message: `Plugin ${id} is enabled but its folder is missing.` });
      continue;
    }
    if (!roots.some((r) => dir === r || dir.startsWith(r + sep))) {
      notes.push({ level: "warning", category: "integrations", message: `Plugin ${id} is installed outside the plugins folder, so it was not read.` });
      continue;
    }
    const [pluginName, marketplace] = id.split("@");
    const provenance = { note: `plugin ${id}`, extra: { plugin: id, pluginHost: P } };
    const manifestPath = join(dir, ".claude-plugin", "plugin.json");
    const manifest = (await readJson(manifestPath, notes)) ?? {};
    if (await pathExists(manifestPath)) out.sourceFiles.push(manifestPath);
    const servers: Record<string, unknown> = {};
    if (manifest.mcpServers && typeof manifest.mcpServers === "object") Object.assign(servers, manifest.mcpServers);
    const mcpPath = join(dir, typeof manifest.mcpServers === "string" ? manifest.mcpServers : ".mcp.json");
    const mcpFile = await readJson(mcpPath, notes);
    if (mcpFile?.mcpServers) {
      out.sourceFiles.push(mcpPath);
      Object.assign(servers, mcpFile.mcpServers);
    }
    out.tools.push(...toolsFromMcpServers(servers, P, `plugins/${id}`, { notes, ...provenance }));
    const skillDirs = Array.isArray(manifest.skills) ? manifest.skills : typeof manifest.skills === "string" ? [manifest.skills] : ["skills"];
    for (const rel of skillDirs) {
      if (typeof rel !== "string") continue;
      const abs = resolve(dir, rel);
      if (abs !== dir && !abs.startsWith(dir + sep)) continue;
      for (const sk of await readSkillsTree(abs, P, notes, 1)) {
        sk.source = { ...(sk.source ?? { platform: P }), note: provenance.note, ...provenance.extra };
        out.skills.push(sk);
      }
    }
    const repo = (marketplaces as any)?.[marketplace ?? ""]?.source?.repo;
    out.integrations.push({
      name: id,
      kind: "claude-code-plugin",
      requiresAuth: false,
      config: { ...(typeof entry.version === "string" ? { version: entry.version } : {}), ...(marketplace ? { marketplace } : {}), ...(typeof repo === "string" ? { marketplaceRepo: repo } : {}), plugin: pluginName },
      notes: "Installed Claude Code plugin",
      source: { platform: P, path: `plugins/${id}` }
    });
    notes.push({ level: "info", category: "integrations", message: `Read installed plugin ${id} (installed plugin read, not installed anywhere by Nomad).` });
  }
  return out;
}

async function readMain(root: string, notes: Note[], includeSecrets: boolean | undefined, agentId?: string) {
  const L = await layoutOf(root);
  const sourceFiles: string[] = [];
  const mdPath = join(root, L.claudeMd);
  let md = await readTextIfExists(mdPath);
  if (md === null && !L.user) {
    md = await readTextIfExists(join(root, ".claude", "CLAUDE.md"));
    if (md !== null) sourceFiles.push(join(root, ".claude", "CLAUDE.md"));
  } else if (md !== null) sourceFiles.push(mdPath);

  const defaultName = L.user ? "Claude Code (user)" : `Claude Code: ${basename(root)}`;
  const doc = createDocument({ name: defaultName, platform: P });
  doc.source.location = root;
  doc.source.nativeId = "main";

  if (md) {
    const id = findAgentIdMarker(md, agentId);
    if (id) {
      doc.id = id;
      const block = extractBlock(md, `agent=${id}`) ?? "";
      const parsed = parseAgentMarkdown(block, P, L.claudeMd);
      const name = firstHeading(block);
      if (name) {
        doc.name = name;
        doc.identity.name = name;
      }
      if (parsed.persona) doc.identity.persona = parsed.persona;
      if (parsed.tone) doc.identity.tone = parsed.tone;
      doc.instructions.push(...parsed.instructions);
      doc.memory.push(...parsed.memory);
      for (const imp of parsed.memoryImports) {
        const p = join(dirname(mdPath), imp);
        const text = await readTextIfExists(p);
        if (text === null) {
          notes.push({ level: "warning", category: "memory", message: `Memory file ${imp} referenced by CLAUDE.md is missing.` });
          continue;
        }
        sourceFiles.push(p);
        doc.memory.push(...parseMemoryMarkdown(text, { platform: P, path: imp, defaultKind: "fact", scope: "agent", idPrefix: "memory" }));
      }
    }
    const outside = removeBlocks(md).trim();
    if (outside) {
      doc.instructions.unshift({ id: "claude-md", kind: "custom", title: "CLAUDE.md", content: outside, source: { platform: P, path: L.claudeMd } });
    }
  }

  const skillsDir = join(root, L.base, "skills");
  doc.skills.push(...(await readSkillsTree(skillsDir, P, notes, 1)));

  const commandsDir = join(root, L.base, "commands");
  for (const e of await listDir(commandsDir)) {
    if (!e.file || !e.name.endsWith(".md")) continue;
    const text = (await readTextIfExists(join(commandsDir, e.name)))!;
    sourceFiles.push(join(commandsDir, e.name));
    const fm = parseFrontmatter(text);
    const { description, "allowed-tools": allowed, ...rest } = fm.data as Record<string, any>;
    const skill: Skill = {
      name: e.name.replace(/\.md$/, ""),
      description: typeof description === "string" ? description : `Slash command /${e.name.replace(/\.md$/, "")}`,
      instructions: fm.body.trim(),
      dependencies: [],
      platforms: [],
      allowedTools: typeof allowed === "string" ? allowed.split(/,\s*/) : Array.isArray(allowed) ? allowed : [],
      config: {},
      references: [],
      files: [],
      frontmatter: { ...rest, "x-claude-code-command": true },
      invocation: "manual",
      source: { platform: P, path: join(L.base, "commands", e.name) }
    };
    doc.skills.push(skill);
  }

  const settingsPath = join(root, L.settings);
  const settings = await readJson(settingsPath, notes);
  if (settings) {
    sourceFiles.push(settingsPath);
    doc.permissions = policyFromSettings(settings);
    if (typeof settings.model === "string") doc.models.preferred = settings.model;
    if (settings.hooks) {
      doc.extensions["x-claude-code"] = { ...(doc.extensions["x-claude-code"] as object), hooks: settings.hooks };
      notes.push({ level: "info", category: "project", message: "Hooks were recorded but are never installed automatically, because they run commands." });
    }
    if (settings.env && Object.keys(settings.env).length) {
      notes.push({ level: "info", category: "integrations", message: `settings.json env has ${Object.keys(settings.env).length} variable(s). They are not migrated; set them in the destination.` });
    }
  }

  const mcpFile = join(L.mcpRoot, L.mcpPath);
  const mcp = await readJson(mcpFile, notes);
  if (mcp?.mcpServers) {
    sourceFiles.push(mcpFile);
    doc.tools.push(...toolsFromMcpServers(mcp.mcpServers, P, L.mcpPath, { notes }));
  }

  if (L.user) {
    const plugins = await readInstalledPlugins(root, settings, notes);
    for (const t of plugins.tools) {
      const same = doc.tools.find((d) => d.mcp && t.mcp && d.mcp.transport === t.mcp.transport && !!d.mcp.url && d.mcp.url === t.mcp.url);
      if (same) {
        notes.push({ level: "info", category: "tools", message: `"${t.name}" from plugin ${String(t.source?.plugin)} points at the same server as "${same.name}", so it is read once.` });
        continue;
      }
      if (doc.tools.some((d) => d.name === t.name)) t.name = `${t.name}-plugin`;
      doc.tools.push(t);
    }
    doc.skills.push(...plugins.skills.filter((sk) => !doc.skills.some((d) => d.name === sk.name)));
    doc.integrations.push(...plugins.integrations);
    sourceFiles.push(...plugins.sourceFiles);
  }
  void includeSecrets;
  return { doc, sourceFiles };
}

async function readSubagent(root: string, stem: string, notes: Note[]) {
  const L = await layoutOf(root);
  const path = join(root, L.base, "agents", `${stem}.md`);
  const text = await readTextIfExists(path);
  if (text === null) throw new Error(`Subagent ${stem} not found at ${path}`);
  const fm = parseFrontmatter(text);
  const data = fm.data as Record<string, any>;
  const name = typeof data.name === "string" ? data.name : stem;
  const doc = createDocument({ name, platform: P, description: typeof data.description === "string" ? data.description : undefined });
  doc.source.location = root;
  doc.source.nativeId = `subagent:${stem}`;
  const id = findAgentIdMarker(text);
  if (id) doc.id = id;
  const parsed = parseAgentMarkdown(fm.body, P, path);
  if (parsed.instructions.length || parsed.persona) {
    doc.instructions.push(...parsed.instructions);
    if (parsed.persona) doc.identity.persona = parsed.persona;
    doc.memory.push(...parsed.memory);
  } else {
    doc.instructions.push({ id: "prompt", kind: "system", title: "System prompt", content: fm.body.replace(/<!--[^>]*-->\n?/g, "").trim(), source: { platform: P, path } });
  }
  const tools = typeof data.tools === "string" ? data.tools.split(/,\s*/).filter(Boolean) : Array.isArray(data.tools) ? data.tools : undefined;
  if (tools) {
    doc.permissions = { mode: "ask", rules: subagentRestrictions(tools), notes: [`Subagent restricted to tools: ${tools.join(", ")}`] };
  }
  if (typeof data.model === "string" && data.model !== "inherit") doc.models.preferred = data.model;
  const { name: _n, description: _d, tools: _t, model: _m, ...rest } = data;
  doc.extensions["x-claude-code"] = { subagent: true, ...(tools ? { tools } : {}), ...(Object.keys(rest).length ? { frontmatter: rest } : {}) };
  void notes;
  return { doc, sourceFiles: [path] };
}

function memoryFilePath(L: Layout, doc: AgentDocument) {
  const dir = `${L.base}nomad/${safeName(slugify(doc.name))}-${doc.id.slice(-6).toLowerCase()}`;
  return { file: `${dir}/memory.md`, importPath: `${dir}/memory.md` };
}

async function planMain(doc: AgentDocument, ctx: WriteContext, L: Layout): Promise<PlannedWrite> {
  const files: DesiredFile[] = [];
  const notes: Note[] = [];
  const manualSteps: string[] = [];
  const conversions: PlannedWrite["conversions"] = [];
  const unsupported: PlannedWrite["unsupported"] = [];
  const key = nomadBlockKey(doc);

  const memImports: string[] = [];
  if (wants(ctx, "memory") && doc.memory.length) {
    const m = memoryFilePath(L, doc);
    files.push({ path: m.file, content: renderMemoryMarkdown(doc.memory, `${doc.name} memory`), strategy: "replace", component: "memory", description: `${doc.memory.length} memory entries`, agentOwned: true });
    memImports.push(m.importPath);
    conversions.push({ category: "memory", item: `${doc.memory.length} entries`, from: "structured memory", to: `${m.file} imported from CLAUDE.md` });
  }
  const instr = wants(ctx, "instructions") ? doc : { ...doc, instructions: [] };
  files.push({
    path: L.claudeMd,
    content: renderAgentMarkdown(instr, { memoryImports: memImports }),
    strategy: "managed-block",
    blockKey: key,
    component: "instructions",
    description: "Agent name, persona and instructions in a Nomad managed section of CLAUDE.md"
  });
  if (doc.identity.persona) conversions.push({ category: "identity", item: "persona", from: "persona", to: "Persona section in CLAUDE.md" });

  // Items from a Claude Code plugin come back by installing the plugin, not by copying them.
  const fromPlugins = new Set<string>([...doc.tools, ...doc.skills].map((x) => pluginOf(x, P)).filter((x): x is string => !!x));
  for (const id of fromPlugins) {
    const info = doc.integrations.find((i) => i.kind === "claude-code-plugin" && i.name === id)?.config as Record<string, unknown> | undefined;
    const market = typeof info?.marketplaceRepo === "string" ? info.marketplaceRepo : (id.split("@")[1] ?? "<marketplace>");
    manualSteps.push(`Install the plugin ${id} in Claude Code: /plugin marketplace add ${market}, then /plugin install ${id}. Nomad does not copy plugin servers or skills.`);
  }
  if (wants(ctx, "skills")) {
    for (const s of doc.skills.filter((x) => !pluginOf(x, P))) {
      if (s.frontmatter["x-claude-code-command"] === true || s.frontmatter["x-codex-prompt"] === true) {
        const { "x-claude-code-command": _c, "x-codex-prompt": _p, ...fm } = s.frontmatter;
        if (_p) conversions.push({ category: "skills", item: s.name, from: "Codex custom prompt", to: "Claude Code slash command" });
        files.push({
          path: `${L.base}commands/${safeName(s.name)}.md`,
          content: stringifyFrontmatter({ description: s.description, ...(s.allowedTools.length ? { "allowed-tools": s.allowedTools.join(", ") } : {}), ...fm }, s.instructions),
          strategy: "replace",
          component: "skills",
          description: `Slash command /${s.name}`,
          agentOwned: true
        });
      } else {
        const { "x-claude-code-command": _c, ...fm } = s.frontmatter;
        files.push(...skillToFiles({ ...s, frontmatter: fm }, `${L.base}skills`));
      }
    }
  }

  const settings: Record<string, unknown> = {};
  if (wants(ctx, "permissions") && (doc.permissions.rules.length || doc.permissions.mode !== "ask")) {
    const s = settingsFromPolicy(doc.permissions);
    if (Object.keys(s.permissions).length) settings.permissions = s.permissions;
    for (const u of s.unenforced) unsupported.push({ category: "permissions", item: u, reason: "Claude Code has no rule for this capability.", alternative: "It is documented in the report. Enforce it at the operating system level if needed." });
    for (const n of s.notes) notes.push({ level: "warning", category: "permissions", message: n });
  }
  if (wants(ctx, "models") && doc.models.preferred) {
    if (modelFamily(doc.models.preferred) === "anthropic") settings.model = bareModel(doc.models.preferred);
    else unsupported.push({ category: "models", item: doc.models.preferred, reason: "Claude Code only runs Anthropic models.", alternative: "Claude Code keeps its current model." });
  }
  if (Object.keys(settings).length) {
    files.push({ path: L.settings, content: JSON.stringify(settings, null, 2) + "\n", strategy: "merge-json", component: "permissions", description: "Permissions and model in settings.json" });
  }

  if (wants(ctx, "tools")) {
    const mcpTools = doc.tools.filter((t) => t.kind === "mcp" && t.mcp && !pluginOf(t, P));
    if (mcpTools.length) {
      // Claude Code fails on an unset ${VAR}; ${VAR:-} is used only where the server accepts an empty value.
      const r = mcpServersFromTools(mcpTools, {
        platformName: "Claude Code",
        envRefStyle: "dollar",
        typeField: true,
        optionalRef: (t, name) => ((((t.mcp as Record<string, unknown>)?.emptyOkEnv as string[] | undefined) ?? []).includes(name) ? `\${${name}:-}` : null)
      });
      unsupported.push(...r.unsupported);
      notes.push(...r.notes);
      files.push({
        path: L.mcpPath,
        root: L.mcpRoot,
        content: JSON.stringify({ mcpServers: r.servers }, null, 2) + "\n",
        strategy: "merge-json",
        component: "tools",
        description: `${mcpTools.length} MCP server(s) in ${L.user ? "~/.claude.json" : ".mcp.json"}`
      });
      manualSteps.push(...r.manualSteps);
      if (L.user) notes.push({ level: "warning", category: "tools", message: "~/.claude.json is also written by Claude Code. Close Claude Code while the migration runs." });
    }
    for (const t of doc.tools.filter((t) => t.kind !== "mcp")) unsupported.push({ category: "tools", item: t.name, reason: "Only MCP servers can be configured from outside Claude Code." });
  }
  if (wants(ctx, "workflows") && doc.workflows.length) {
    for (const w of doc.workflows) unsupported.push({ category: "workflows", item: w.name, reason: "Claude Code has no local scheduler.", alternative: "Use a system scheduler or another platform for this routine." });
    manualSteps.push(...workflowManualSteps(doc, "Claude Code"));
  }
  if (wants(ctx, "integrations")) for (const i of doc.integrations.filter((x) => !(x.kind === "claude-code-plugin" && fromPlugins.has(x.name)))) manualSteps.push(i.kind.endsWith("-plugin") ? `The ${i.name} plugin was installed on the source. Reinstall it, or its equivalent, if you want it here; Nomad never installs plugins.` : `Reconnect the ${i.name} integration in Claude Code.`);
  if (wants(ctx, "knowledge") && (doc.knowledge.length || doc.files.length)) manualSteps.push(`Copy ${doc.knowledge.length + doc.files.length} knowledge file(s) into your project and reference them from CLAUDE.md.`);
  return { nativeId: "main", files, notes, manualSteps, conversions, unsupported };
}

function planSubagent(doc: AgentDocument, ctx: WriteContext, L: Layout, stem: string): PlannedWrite {
  const files: DesiredFile[] = [];
  const manualSteps: string[] = [];
  const unsupported: PlannedWrite["unsupported"] = [];
  const ext = (doc.extensions["x-claude-code"] ?? {}) as any;
  const fm: Record<string, unknown> = {
    name: slugify(doc.name),
    description: doc.description ?? doc.identity.description ?? `${doc.name} (migrated by Nomad)`,
    ...(toolsForSubagent(doc) ? { tools: toolsForSubagent(doc)!.join(", ") } : {}),
    ...(subagentModel(doc) ? { model: subagentModel(doc) } : {}),
    ...(ext.frontmatter ?? {})
  };
  const body = `<!-- nomad:agent=${doc.id} -->\n` + renderAgentMarkdown(wants(ctx, "instructions") ? doc : { ...doc, instructions: [] }, { includeMemory: wants(ctx, "memory"), heading: false });
  files.push({ path: `${L.base}agents/${stem}.md`, content: stringifyFrontmatter(fm, body), strategy: "replace", component: "instructions", description: `Subagent ${stem}`, agentOwned: true });
  if (wants(ctx, "skills")) for (const s of doc.skills) files.push(...skillToFiles(s, `${L.base}skills`));
  if (doc.tools.length && wants(ctx, "tools")) manualSteps.push(`Subagents share the project's MCP servers. Add ${doc.tools.map((t) => t.name).join(", ")} to Claude Code if they are not configured yet.`);
  if (wants(ctx, "workflows")) {
    for (const w of doc.workflows) unsupported.push({ category: "workflows", item: w.name, reason: "Claude Code has no local scheduler." });
    manualSteps.push(...workflowManualSteps(doc, "Claude Code"));
  }
  const restricted = doc.permissions.rules.filter((r) => r.effect !== "allow" && r.pattern);
  for (const r of restricted) unsupported.push({ category: "permissions", item: `${r.effect} ${r.capability} (${r.pattern})`, reason: "Subagents only support a tool allowlist.", alternative: "Add the rule to settings.json if it should apply to the whole project." });
  return { nativeId: `subagent:${stem}`, files, notes: [], manualSteps, conversions: [], unsupported };
}

export const claudeCodeAdapter: Adapter = {
  info: CLAUDE_CODE_INFO,

  async detect(root) {
    const evidence: string[] = [];
    for (const f of ["CLAUDE.md", "settings.json", "agents", "skills", "commands", ".claude", ".mcp.json"]) if (await pathExists(join(root, f))) evidence.push(f);
    const strong = basename(root) === ".claude" || evidence.includes(".claude") || evidence.includes("settings.json");
    return { detected: strong || evidence.includes("CLAUDE.md"), confidence: strong ? 0.9 : evidence.length ? 0.4 : 0, evidence };
  },

  async discover(root) {
    const L = await layoutOf(root);
    const refs: AgentRef[] = [];
    const md = await readTextIfExists(join(root, L.claudeMd));
    const name = (md && findAgentIdMarker(md) && firstHeading(extractBlock(md, `agent=${findAgentIdMarker(md)}`) ?? "")) || (L.user ? "Claude Code (user)" : `Claude Code: ${basename(root)}`);
    if (md !== null || (await pathExists(join(root, L.settings))) || (await isDirectory(join(root, L.base, "skills")))) {
      refs.push({ nativeId: "main", name, description: "Main configuration (CLAUDE.md, settings, skills, MCP)", location: root, kind: "main" });
    }
    for (const e of await listDir(join(root, L.base, "agents"))) {
      if (!e.file || !e.name.endsWith(".md")) continue;
      const fm = parseFrontmatter((await readTextIfExists(join(root, L.base, "agents", e.name))) ?? "");
      refs.push({
        nativeId: `subagent:${e.name.replace(/\.md$/, "")}`,
        name: String(fm.data.name ?? e.name.replace(/\.md$/, "")),
        description: typeof fm.data.description === "string" ? fm.data.description : "Subagent",
        location: join(root, L.base, "agents", e.name),
        kind: "subagent"
      });
    }
    return refs;
  },

  async read(root, nativeId, options = {}) {
    const notes: Note[] = [];
    if (nativeId.startsWith("subagent:")) {
      const r = await readSubagent(root, nativeId.slice("subagent:".length), notes);
      return { ...r, notes };
    }
    const r = await readMain(root, notes, options.includeSecrets, options.agentId);
    return { ...r, notes };
  },

  async plan(doc, ctx) {
    const L = await layoutOf(ctx.root);
    if (ctx.mode === "copy" || ctx.targetNativeId?.startsWith("subagent:")) {
      const stem = ctx.targetNativeId?.startsWith("subagent:") && ctx.mode !== "copy" ? ctx.targetNativeId.slice(9) : safeName(slugify(ctx.targetName ?? doc.name));
      return planSubagent(doc, ctx, L, stem);
    }
    return planMain(doc, ctx, L);
  },

  async readPolicy(root, nativeId) {
    if (nativeId?.startsWith("subagent:")) {
      try {
        return (await readSubagent(root, nativeId.slice(9), [])).doc.permissions;
      } catch {
        return null;
      }
    }
    const L = await layoutOf(root);
    const settings = await readJson(join(root, L.settings), []);
    return settings ? policyFromSettings(settings) : null;
  },

  async verify(doc, root, nativeId, ctx) {
    const checks: VerifyCheck[] = [];
    let read;
    try {
      read = await this.read!(root, nativeId, { agentId: doc.id });
      checks.push({ name: "Destination configuration is readable", ok: true });
    } catch (e) {
      return [{ name: "Destination configuration is readable", ok: false, detail: (e as Error).message }];
    }
    const got = read.doc;
    checks.push({ name: "Agent identity marker present", ok: got.id === doc.id, detail: got.id === doc.id ? undefined : "The Nomad identity marker was not found" });
    if (wants(ctx, "instructions")) {
      const missing = doc.instructions.filter((i) => i.content.trim() && !got.instructions.some((g) => g.content.trim() === i.content.trim()));
      checks.push({ name: "Instructions preserved", ok: missing.length === 0, detail: missing.length ? `Missing: ${missing.map((m) => m.id).join(", ")}` : undefined });
    }
    if (wants(ctx, "memory") && doc.memory.length) {
      const ids = new Set(got.memory.map((m) => m.id));
      const missing = doc.memory.filter((m) => !ids.has(m.id));
      checks.push({ name: "Memory transferred", ok: missing.length === 0, detail: missing.length ? `${missing.length} entries missing` : `${doc.memory.length} entries` });
    }
    if (wants(ctx, "skills") && doc.skills.length && !nativeId.startsWith("subagent:")) {
      const names = new Set(got.skills.map((s) => s.name));
      const missing = doc.skills.filter((s) => !pluginOf(s, this.info.id) && !names.has(s.name));
      checks.push({ name: "Skills written", ok: missing.length === 0, detail: missing.length ? `Missing: ${missing.map((s) => s.name).join(", ")}` : undefined });
    }
    if (wants(ctx, "tools") && doc.tools.some((t) => t.kind === "mcp") && !nativeId.startsWith("subagent:")) {
      const names = new Set(got.tools.map((t) => t.name));
      const missing = doc.tools.filter((t) => t.kind === "mcp" && t.enabled !== false && !pluginOf(t, this.info.id) && !names.has(t.name));
      checks.push({ name: "MCP servers configured", ok: missing.length === 0, detail: missing.length ? `Missing: ${missing.map((t) => t.name).join(", ")}` : undefined });
    }
    return checks;
  }
};

export { readSkillDir };
