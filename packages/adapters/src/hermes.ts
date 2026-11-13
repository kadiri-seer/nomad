import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentDocument, Integration, MemoryEntry, PermissionPolicy, Skill, Tool, Workflow } from "@nomad/schema";
import {
  createDocument,
  extractBlock,
  findAgentIdMarker,
  firstHeading,
  removeBlocks,
  sha256,
  type Adapter,
  type AgentRef,
  type DesiredFile,
  type Note,
  type PlannedWrite,
  type VerifyCheck,
  type WriteContext
} from "@nomad/core";
import { listDir, pathExists, readTextIfExists } from "@nomad/core/node";
import { HERMES_INFO } from "./catalog";
import {
  mcpServersFromTools,
  nomadBlockKey,
  parseAgentMarkdown,
  plainEntry,
  qualifiedModel,
  readSkillsTree,
  renderAgentMarkdown,
  rule,
  safeName,
  skillToFiles,
  toolsFromMcpServers,
  pluginOf,
  wants,
  workflowPrompt
} from "./util";

const P = "hermes";
export const HERMES_DELIMITER = "§";
const MEMORY_LIMIT = 2200;
const USER_LIMIT = 1375;

function homeFor(root: string, nativeId: string): string {
  return nativeId.startsWith("profile:") ? join(root, "profiles", nativeId.slice(8)) : root;
}

function splitEntries(text: string): string[] {
  return text
    .split(HERMES_DELIMITER)
    .map((e) => e.trim())
    .filter(Boolean);
}

async function loadYaml(path: string, notes: Note[]): Promise<any> {
  const text = await readTextIfExists(path);
  if (text === null) return undefined;
  try {
    return parseYaml(text) ?? {};
  } catch (e) {
    notes.push({ level: "error", message: `config.yaml could not be parsed: ${(e as Error).message}` });
    return undefined;
  }
}

function parseSchedule(s: any, createdAt?: string): { trigger: Workflow["trigger"]; tz?: string } | null {
  if (s && typeof s === "object") {
    if (s.kind === "cron" && s.expr) return { trigger: { kind: "cron", expr: String(s.expr) } };
    if (s.kind === "interval" && Number(s.minutes) > 0) return { trigger: { kind: "interval", everyMs: Number(s.minutes) * 60000 } };
    if (s.kind === "once" && s.run_at) return { trigger: { kind: "once", at: String(s.run_at) } };
    if (s.display) return parseSchedule(String(s.display), createdAt);
    return null;
  }
  if (typeof s !== "string") return null;
  const str = s.trim();
  const unit = (u: string) => (u === "m" ? 60000 : u === "h" ? 3600000 : 86400000);
  let m = /^every\s+(\d+)\s*([mhd])/i.exec(str);
  if (m) return { trigger: { kind: "interval", everyMs: Number(m[1]) * unit(m[2].toLowerCase()) } };
  m = /^(\d+)\s*([mhd])$/i.exec(str);
  if (m) {
    const base = createdAt ? Date.parse(createdAt) : Date.now();
    return { trigger: { kind: "once", at: new Date(base + Number(m[1]) * unit(m[2].toLowerCase())).toISOString() } };
  }
  if (!Number.isNaN(Date.parse(str)) && /^\d{4}-\d{2}-\d{2}/.test(str)) return { trigger: { kind: "once", at: str } };
  if (str.split(/\s+/).length === 5) return { trigger: { kind: "cron", expr: str } };
  return null;
}

function scheduleFor(w: Workflow): Record<string, unknown> | null {
  switch (w.trigger.kind) {
    case "cron":
      return { kind: "cron", expr: w.trigger.expr, display: w.trigger.expr };
    case "interval": {
      const minutes = Math.max(1, Math.round(w.trigger.everyMs / 60000));
      return { kind: "interval", minutes, display: `every ${minutes}m` };
    }
    case "once":
      return { kind: "once", run_at: w.trigger.at, display: w.trigger.at };
    default:
      return null;
  }
}

function memoryEntriesFrom(text: string, kind: MemoryEntry["kind"], scope: MemoryEntry["scope"], path: string): MemoryEntry[] {
  return splitEntries(text).map((content) => ({
    id: `hermes-${scope}-${sha256(content).slice(0, 10)}`,
    kind,
    scope,
    content,
    tags: [],
    source: { platform: P, path }
  }));
}

/**
 * Installed Hermes plugins. Portable plugins (plugin.json, mcp.json, skills/)
 * are read; native Python plugins are listed but their code is never read or
 * run. ~/.hermes/.env is never read. A plugin that is not in plugins.enabled
 * has its servers read as disabled.
 */
export async function readPlugins(h: string, cfg: any, notes: Note[]): Promise<{ tools: Tool[]; skills: Skill[]; integrations: Integration[]; sourceFiles: string[] }> {
  const out = { tools: [] as Tool[], skills: [] as Skill[], integrations: [] as Integration[], sourceFiles: [] as string[] };
  const enabled = new Set<string>(Array.isArray(cfg?.plugins?.enabled) ? cfg.plugins.enabled.map(String) : []);
  const disabled = new Set<string>(Array.isArray(cfg?.plugins?.disabled) ? cfg.plugins.disabled.map(String) : []);
  const base = join(h, "plugins");
  // Flat (plugins/<name>) or one category level (plugins/<category>/<name>).
  const dirs: Array<{ rel: string; abs: string }> = [];
  for (const e of await listDir(base)) {
    if (!e.dir || e.name.startsWith(".")) continue;
    const abs = join(base, e.name);
    if ((await pathExists(join(abs, "plugin.json"))) || (await pathExists(join(abs, "plugin.yaml")))) dirs.push({ rel: e.name, abs });
    else for (const c of await listDir(abs)) if (c.dir && !c.name.startsWith(".") && ((await pathExists(join(abs, c.name, "plugin.json"))) || (await pathExists(join(abs, c.name, "plugin.yaml"))))) dirs.push({ rel: `${e.name}/${c.name}`, abs: join(abs, c.name) });
  }
  for (const d of dirs) {
    const manifestText = await readTextIfExists(join(d.abs, "plugin.json"));
    if (manifestText === null) {
      // Native plugin: Python code. Listed, never imported or run.
      out.integrations.push({ name: d.rel.split("/").pop()!, kind: "hermes-plugin", requiresAuth: false, config: { native: true }, notes: "Native Hermes plugin (Python). Its code was not read or copied.", source: { platform: P, path: `plugins/${d.rel}` } });
      notes.push({ level: "info", category: "integrations", message: `Hermes plugin ${d.rel} is a native plugin: code not read or copied.` });
      continue;
    }
    let manifest: any;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      notes.push({ level: "warning", category: "integrations", message: `plugins/${d.rel}/plugin.json could not be parsed and was skipped.` });
      continue;
    }
    out.sourceFiles.push(join(d.abs, "plugin.json"));
    const name = typeof manifest.name === "string" && manifest.name ? manifest.name : d.rel.split("/").pop()!;
    const on = enabled.has(name) && !disabled.has(name);
    const provenance = { note: `plugin ${name}`, extra: { plugin: name, pluginHost: P } };
    const trust: Record<string, unknown> = manifest.extensions?.["com.nousresearch.hermes"]?.servers ?? {};
    const mcpText = await readTextIfExists(join(d.abs, "mcp.json"));
    const requiredEnv: string[] = [];
    if (mcpText !== null) {
      out.sourceFiles.push(join(d.abs, "mcp.json"));
      try {
        const servers = JSON.parse(mcpText).mcpServers ?? {};
        const tools = toolsFromMcpServers(servers, P, `plugins/${d.rel}/mcp.json`, { notes, refsOptional: true, ...provenance });
        for (const t of tools) {
          if (!on) t.enabled = false;
          const tr = (trust[t.name] as { trust?: unknown } | undefined)?.trust;
          if (typeof tr === "string") (t as Record<string, unknown>).extensions = { "x-hermes": { trust: tr } };
          for (const [k, v] of Object.entries(t.mcp!.env)) if (!("value" in v)) requiredEnv.push(k);
        }
        out.tools.push(...tools);
      } catch {
        notes.push({ level: "warning", category: "tools", message: `plugins/${d.rel}/mcp.json could not be parsed and was skipped.` });
      }
    }
    // Skills of a plugin that is not enabled are not read: copying them elsewhere would switch them on.
    const skills = on ? await readSkillsTree(join(d.abs, "skills"), P, notes, 2) : [];
    for (const sk of skills) sk.source = { ...(sk.source ?? { platform: P }), note: provenance.note, ...provenance.extra };
    out.skills.push(...skills);
    out.integrations.push({
      name,
      kind: "hermes-plugin",
      requiresAuth: requiredEnv.length > 0,
      config: { ...(typeof manifest.version === "string" ? { version: manifest.version } : {}), enabled: on, ...(requiredEnv.length ? { requiredEnv: [...new Set(requiredEnv)] } : {}) },
      notes: on ? "Installed and enabled Hermes plugin" : "Installed Hermes plugin, not enabled",
      source: { platform: P, path: `plugins/${d.rel}/plugin.json` }
    });
    notes.push({ level: "info", category: "integrations", message: `Read installed Hermes plugin ${name}${on ? "" : " (not enabled, so its servers stay off)"}. Nomad never installs or enables plugins.` });
  }
  return out;
}

async function readHome(root: string, nativeId: string, notes: Note[], agentId?: string) {
  const h = homeFor(root, nativeId);
  const sourceFiles: string[] = [];
  const read = async (rel: string) => {
    const t = await readTextIfExists(join(h, rel));
    if (t !== null) sourceFiles.push(join(h, rel));
    return t;
  };
  const doc = createDocument({ name: nativeId === "default" ? "Hermes" : `Hermes: ${nativeId.slice(8)}`, platform: P });
  doc.source.location = h;
  doc.source.nativeId = nativeId;

  const soul = await read("SOUL.md");
  if (soul !== null) {
    const id = findAgentIdMarker(soul, agentId);
    if (id) {
      doc.id = id;
      const block = extractBlock(soul, `agent=${id}`) ?? "";
      const parsed = parseAgentMarkdown(block, P, "SOUL.md");
      const name = firstHeading(block);
      if (name) {
        doc.name = name;
        doc.identity.name = name;
      }
      if (parsed.persona) doc.identity.persona = parsed.persona;
      if (parsed.tone) doc.identity.tone = parsed.tone;
      doc.instructions.push(...parsed.instructions);
    }
    const outside = removeBlocks(soul).trim();
    if (outside) doc.identity.persona = doc.identity.persona ? `${outside}\n\n${doc.identity.persona}` : outside;
  }
  const mem = await read("memories/MEMORY.md");
  if (mem) doc.memory.push(...memoryEntriesFrom(mem, "fact", "agent", "memories/MEMORY.md"));
  const user = await read("memories/USER.md");
  if (user) doc.memory.push(...memoryEntriesFrom(user, "profile", "user", "memories/USER.md"));
  for (const e of await listDir(join(h, "memories", "archive"))) {
    if (!e.file || !e.name.endsWith(".md")) continue;
    const text = (await read(`memories/archive/${e.name}`))!;
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(e.name)?.[1];
    const marker = /<!-- nomad:memory id=("[^"]*"|\S+)/.exec(text)?.[1]?.replace(/"/g, "");
    doc.memory.push({ id: marker ?? `archive-${e.name.replace(/\.md$/, "")}`, kind: "daily-log", scope: "agent", title: date ? `Log ${date}` : e.name, content: text.replace(/<!-- nomad:memory [^>]*-->\n?/g, "").trim(), date, tags: [], source: { platform: P, path: `memories/archive/${e.name}` } });
  }

  const cfg = await loadYaml(join(h, "config.yaml"), notes);
  if (cfg) {
    sourceFiles.push(join(h, "config.yaml"));
    const model = typeof cfg.model === "string" ? cfg.model : cfg.model?.default;
    if (typeof model === "string") doc.models.preferred = model;
    if (typeof cfg.model?.provider === "string") doc.models.provider = cfg.model.provider;
    // Hermes drops a stdio env entry whose reference is unset, so references there are optional.
    if (cfg.mcp_servers) doc.tools.push(...toolsFromMcpServers(cfg.mcp_servers, P, "config.yaml", { notes, refsOptional: true }));
    if (Array.isArray(cfg.command_allowlist)) {
      doc.permissions = { mode: "ask", rules: cfg.command_allowlist.map((c: unknown) => rule("shell", "allow", String(c), "hermes:command_allowlist")), notes: ["Hermes command allowlist"] };
    }
  }
  if (await pathExists(join(h, ".env"))) notes.push({ level: "info", category: "integrations", message: "~/.hermes/.env holds secrets. It is never read or migrated." });

  doc.skills.push(...(await readSkillsTree(join(h, "skills"), P, notes, 3)));

  const plugins = await readPlugins(h, cfg, notes);
  for (const t of plugins.tools) {
    // A plugin server with the same name as one in config.yaml is kept apart, not merged.
    if (doc.tools.some((d) => d.name === t.name)) t.name = `${t.name}-plugin`;
    doc.tools.push(t);
  }
  doc.skills.push(...plugins.skills.filter((s) => !doc.skills.some((d) => d.name === s.name)));
  doc.integrations.push(...plugins.integrations);
  sourceFiles.push(...plugins.sourceFiles);

  const jobsText = await read("cron/jobs.json");
  if (jobsText) {
    try {
      const raw = JSON.parse(jobsText);
      const jobs: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.jobs) ? raw.jobs : [];
      for (const j of jobs) {
        const sched = parseSchedule(j.schedule, j.created_at);
        if (!sched) {
          notes.push({ level: "warning", category: "workflows", message: `Cron job ${j.name ?? j.id} has an unrecognised schedule and was skipped.` });
          continue;
        }
        const skills: string[] = Array.isArray(j.skills) ? j.skills : j.skill ? [j.skill] : [];
        doc.workflows.push({
          id: String(j.id ?? j.name),
          name: String(j.name ?? j.id ?? "Routine"),
          trigger: sched.trigger,
          timezone: typeof j.timezone === "string" ? j.timezone : undefined,
          actions: [...skills.map((s) => ({ kind: "skill" as const, name: s })), { kind: "prompt" as const, text: String(j.prompt ?? "") }],
          requiredTools: [],
          dependencies: skills,
          conditions: [],
          delivery: typeof j.deliver === "string" ? j.deliver : undefined,
          sourceEnabled: j.enabled !== false && j.state !== "paused" && j.state !== "completed" && !j.paused_at,
          enabled: false,
          source: { platform: P, path: "cron/jobs.json" }
        });
      }
    } catch (e) {
      notes.push({ level: "warning", category: "workflows", message: `cron/jobs.json could not be parsed: ${(e as Error).message}` });
    }
  }
  return { doc, sourceFiles };
}

async function planHome(doc: AgentDocument, ctx: WriteContext): Promise<PlannedWrite> {
  const notes: Note[] = [];
  const manualSteps: string[] = [];
  const conversions: PlannedWrite["conversions"] = [];
  const unsupported: PlannedWrite["unsupported"] = [];
  let nativeId = ctx.targetNativeId ?? "default";
  if (ctx.mode === "copy") {
    const base = safeName((ctx.targetName ?? doc.name).toLowerCase());
    nativeId = `profile:${base}`;
    let i = 2;
    while (await pathExists(join(ctx.root, "profiles", nativeId.slice(8)))) nativeId = `profile:${base}-${i++}`;
    notes.push({ level: "info", message: `A new Hermes profile "${nativeId.slice(8)}" will be created. Use it with "hermes -p ${nativeId.slice(8)}".` });
  }
  const prefix = nativeId === "default" ? "" : `profiles/${nativeId.slice(8)}/`;
  const files: DesiredFile[] = [];
  const h = homeFor(ctx.root, nativeId);

  const existingSoul = await readTextIfExists(join(h, "SOUL.md"));
  const soulHasOwn = existingSoul !== null && removeBlocks(existingSoul).trim().length > 0;
  const keepPersona = !(soulHasOwn && ctx.mode === "merge");
  if (!keepPersona && doc.identity.persona) {
    notes.push({ level: "warning", category: "identity", message: "SOUL.md already has a persona. Merge keeps it; choose replace to use the incoming persona." });
  }
  files.push({
    path: `${prefix}SOUL.md`,
    content: renderAgentMarkdown(wants(ctx, "instructions") ? doc : { ...doc, instructions: [] }, { includePersona: keepPersona }),
    strategy: "managed-block",
    blockKey: nomadBlockKey(doc),
    component: "identity",
    description: "Persona and instructions in SOUL.md"
  });
  if (doc.instructions.length && wants(ctx, "instructions")) conversions.push({ category: "instructions", item: `${doc.instructions.length} section(s)`, from: "instruction files", to: "Nomad section of SOUL.md" });

  if (wants(ctx, "memory") && doc.memory.length) {
    const user = doc.memory.filter((m) => m.scope === "user" || m.kind === "profile");
    const logs = doc.memory.filter((m) => m.kind === "daily-log" || m.kind === "document");
    const rest = doc.memory.filter((m) => !user.includes(m) && !logs.includes(m));
    const sep = `\n${HERMES_DELIMITER}\n`;
    const check = async (rel: string, entries: MemoryEntry[], limit: number, label: string) => {
      if (!entries.length) return;
      const existing = splitEntries((await readTextIfExists(join(h, rel))) ?? "");
      const all = [...existing, ...entries.map((e) => plainEntry(e.content)).filter((e) => !existing.includes(e))];
      const size = all.join(sep).length;
      files.push({ path: `${prefix}${rel}`, content: entries.map((e) => plainEntry(e.content)).join(sep) + "\n", strategy: "append-entries", entryDelimiter: HERMES_DELIMITER, component: "memory", description: `${entries.length} ${label} entries` });
      if (size > limit) {
        notes.push({ level: "warning", category: "memory", message: `${rel} will hold ${size} characters, above the Hermes default limit of ${limit}. Hermes keeps loading it but refuses new memory until it is consolidated.` });
        manualSteps.push(`Raise memory.${label === "user" ? "user_char_limit" : "memory_char_limit"} in config.yaml to at least ${size}, or ask Hermes to consolidate ${rel}.`);
      }
    };
    await check("memories/MEMORY.md", rest, MEMORY_LIMIT, "memory");
    await check("memories/USER.md", user, USER_LIMIT, "user");
    if (rest.length || user.length) conversions.push({ category: "memory", item: `${rest.length + user.length} entries`, from: "structured memory", to: "§ delimited MEMORY.md and USER.md (kinds and titles are not kept)" });
    for (const m of logs) {
      const name = m.date ? `${m.date}.md` : `${safeName(m.id)}.md`;
      files.push({ path: `${prefix}memories/archive/${name}`, content: `<!-- nomad:memory id=${JSON.stringify(m.id)} -->\n${m.content.trim()}\n`, strategy: "create-only", component: "memory", description: `Archived log ${m.date ?? m.id}` });
    }
    if (logs.length) conversions.push({ category: "memory", item: `${logs.length} logs`, from: "daily logs", to: "memories/archive (readable on request, not loaded into every prompt)" });
  }

  // Servers and skills from a Hermes plugin come back by reinstalling the plugin, not by copying them.
  const fromPlugins = new Set<string>([...doc.tools, ...doc.skills].map((x) => pluginOf(x, P)).filter((x): x is string => !!x));
  for (const name of fromPlugins) {
    manualSteps.push(`Install and enable the Hermes plugin ${name}: "hermes plugins install ${name}", then "hermes plugins enable ${name}" (portable plugins install disabled). Nomad does not copy plugin servers or skills into config.yaml or skills/.`);
  }
  if (wants(ctx, "skills")) {
    for (const s of doc.skills.filter((x) => !pluginOf(x, P))) {
      const { "x-claude-code-command": c, "x-codex-prompt": p, ...fm } = s.frontmatter;
      files.push(...skillToFiles({ ...s, frontmatter: fm }, `${prefix}skills/nomad-imports`));
      if (c || p) conversions.push({ category: "skills", item: s.name, from: c ? "Claude Code slash command" : "Codex custom prompt", to: "Hermes skill" });
    }
  }

  const cfg: Record<string, unknown> = {};
  if (wants(ctx, "models") && doc.models.preferred) {
    const existing = await loadYaml(join(h, "config.yaml"), []);
    const model = qualifiedModel(doc.models.preferred, doc.models.provider);
    cfg.model = typeof existing?.model === "string" ? model : { default: model };
    manualSteps.push(`Check that Hermes has a provider for ${model} ("hermes model").`);
  }
  if (wants(ctx, "tools")) {
    const mcpTools = doc.tools.filter((t) => t.kind === "mcp" && t.mcp && !pluginOf(t, P));
    if (mcpTools.length) {
      // Hermes expands ${VAR} from ~/.hermes/.env and drops entries whose reference is unset.
      const r = mcpServersFromTools(mcpTools, { platformName: "Hermes", envRefStyle: "dollar", optionalRef: (_t, name) => `\${${name}}` });
      cfg.mcp_servers = r.servers;
      const refNames = [...new Set(Object.values(r.refs).flatMap((x) => [...x.env.filter((k) => Object.values(r.servers).some((sv: any) => sv.env?.[k])), ...x.headers.map(([, v]) => v)]))];
      if (refNames.length) manualSteps.push(`Add ${refNames.join(", ")} to ~/.hermes/.env (Nomad never reads or writes that file).`);
      manualSteps.push(...r.manualSteps.filter((m) => !m.startsWith("Set ")));
      unsupported.push(...r.unsupported);
      notes.push(...r.notes);
    }
  }
  if (wants(ctx, "permissions")) {
    const allow = doc.permissions.rules.filter((r) => r.capability === "shell" && r.effect === "allow" && r.pattern).map((r) => r.pattern!);
    if (allow.length) cfg.command_allowlist = allow;
    for (const r of doc.permissions.rules.filter((r) => !(r.capability === "shell" && r.effect === "allow" && r.pattern))) {
      if (r.source?.startsWith("hermes:")) continue;
      unsupported.push({ category: "permissions", item: `${r.effect} ${r.capability}${r.pattern ? ` (${r.pattern})` : ""}`, reason: "Hermes only has a command allowlist.", alternative: "Use a sandboxed terminal backend (Docker or SSH) to restrict what Hermes can do." });
    }
  }
  if (Object.keys(cfg).length) {
    files.push({ path: `${prefix}config.yaml`, content: stringifyYaml(cfg), strategy: "merge-yaml", component: "project", description: "Model, MCP servers and command allowlist in config.yaml" });
  }

  if (wants(ctx, "workflows") && doc.workflows.length) {
    const jobs: Record<string, unknown>[] = [];
    for (const w of doc.workflows) {
      const schedule = scheduleFor(w);
      if (!schedule) {
        unsupported.push({ category: "workflows", item: w.name, reason: `Hermes cron cannot run ${w.trigger.kind} triggers.` });
        continue;
      }
      const skills = w.actions.filter((a) => a.kind === "skill").map((a) => (a as { name: string }).name);
      jobs.push({
        id: w.source?.platform === P ? w.id : `nomad-${safeName(w.id)}`.slice(0, 40),
        name: w.name,
        prompt: workflowPrompt(w.actions.filter((a) => a.kind !== "skill")),
        schedule,
        ...(skills.length ? { skills } : {}),
        ...(w.timezone ? { timezone: w.timezone } : {}),
        deliver: "local",
        enabled: false,
        state: "paused",
        paused_at: new Date().toISOString(),
        paused_reason: `Imported by Nomad. Resume with: hermes cron resume ${w.source?.platform === P ? w.id : `nomad-${safeName(w.id)}`.slice(0, 40)}`,
        next_run_at: null,
        created_at: new Date().toISOString()
      });
    }
    if (jobs.length) {
      const existing = await readTextIfExists(join(h, "cron", "jobs.json"));
      let bare = false;
      try {
        bare = existing ? Array.isArray(JSON.parse(existing)) : false;
      } catch {
        /* reported by the engine */
      }
      files.push({ path: `${prefix}cron/jobs.json`, content: JSON.stringify(bare ? jobs : { jobs }, null, 2) + "\n", strategy: "merge-json", arrayKeys: bare ? { "": "id" } : { jobs: "id" }, component: "workflows", description: `${jobs.length} cron job(s), imported paused` });
      manualSteps.push(`Review the imported routines and resume them with "hermes cron resume <id>". Results are delivered locally until you change the target.`);
    }
  }
  if (wants(ctx, "integrations")) for (const i of doc.integrations.filter((x) => !(x.kind === "hermes-plugin" && fromPlugins.has(x.name)))) manualSteps.push(i.kind.endsWith("-plugin") ? `Reinstall the ${i.name} plugin if you want it here; plugins are never installed by Nomad.` : `Reconnect ${i.name} in Hermes ("hermes gateway setup"). Credentials are never migrated.`);
  if (wants(ctx, "knowledge") && (doc.knowledge.length || doc.files.length)) manualSteps.push(`Copy ${doc.knowledge.length + doc.files.length} knowledge file(s) somewhere Hermes can read them.`);
  return { nativeId, files, notes, manualSteps, conversions, unsupported };
}

export const hermesAdapter: Adapter = {
  info: HERMES_INFO,

  async detect(root) {
    const evidence: string[] = [];
    for (const f of ["config.yaml", "SOUL.md", "memories", "skills", "cron", "profiles"]) if (await pathExists(join(root, f))) evidence.push(f);
    const strong = evidence.includes("config.yaml") && (evidence.includes("memories") || evidence.includes("SOUL.md"));
    return { detected: strong || (root.endsWith(".hermes") && evidence.length > 0), confidence: strong ? 0.9 : 0.5, evidence };
  },

  async discover(root) {
    const refs: AgentRef[] = [];
    const d = await this.detect(root);
    if (d.detected) {
      const soul = await readTextIfExists(join(root, "SOUL.md"));
      const id = soul ? findAgentIdMarker(soul) : null;
      refs.push({ nativeId: "default", name: (id && firstHeading(extractBlock(soul!, `agent=${id}`) ?? "")) || "Hermes (default profile)", location: root, kind: "profile" });
    }
    for (const e of await listDir(join(root, "profiles"))) {
      if (e.dir) refs.push({ nativeId: `profile:${e.name}`, name: `Hermes profile ${e.name}`, location: join(root, "profiles", e.name), kind: "profile" });
    }
    return refs;
  },

  async read(root, nativeId, options = {}) {
    const notes: Note[] = [];
    return { ...(await readHome(root, nativeId, notes, options.agentId)), notes };
  },

  plan: planHome,

  async readPolicy(root, nativeId) {
    const cfg = await loadYaml(join(homeFor(root, nativeId ?? "default"), "config.yaml"), []);
    if (!cfg) return null;
    const list = Array.isArray(cfg.command_allowlist) ? cfg.command_allowlist : [];
    const policy: PermissionPolicy = { mode: "ask", rules: list.map((c: unknown) => rule("shell", "allow", String(c), "hermes:command_allowlist")), notes: [] };
    return policy;
  },

  async verify(doc, root, nativeId, ctx) {
    const checks: VerifyCheck[] = [];
    const notes: Note[] = [];
    const h = homeFor(root, nativeId);
    if (await pathExists(join(h, "config.yaml"))) {
      await loadYaml(join(h, "config.yaml"), notes);
      checks.push({ name: "config.yaml parses", ok: !notes.some((n) => n.level === "error"), detail: notes[0]?.message });
    }
    const got = (await readHome(root, nativeId, [], doc.id)).doc;
    checks.push({ name: "Nomad section present in SOUL.md", ok: got.id === doc.id });
    if (wants(ctx, "instructions")) {
      const missing = doc.instructions.filter((i) => i.content.trim() && !got.instructions.some((g) => g.content.trim() === i.content.trim()));
      checks.push({ name: "Instructions preserved", ok: !missing.length, detail: missing.length ? `Missing: ${missing.map((m) => m.id).join(", ")}` : undefined });
    }
    if (wants(ctx, "memory") && doc.memory.length) {
      const contents = new Set(got.memory.map((m) => plainEntry(m.content)));
      const ids = new Set(got.memory.map((m) => m.id));
      const missing = doc.memory.filter((m) => !contents.has(plainEntry(m.content)) && !ids.has(m.id)).length;
      checks.push({ name: "Memory transferred", ok: missing === 0, detail: missing ? `${missing} entries missing` : `${doc.memory.length} entries` });
    }
    if (wants(ctx, "skills") && doc.skills.length) {
      const names = new Set(got.skills.map((s) => s.name));
      const missing = doc.skills.filter((s) => !pluginOf(s, this.info.id) && !names.has(s.name));
      checks.push({ name: "Skills written", ok: !missing.length, detail: missing.length ? `Missing: ${missing.map((s) => s.name).join(", ")}` : undefined });
    }
    if (wants(ctx, "workflows") && doc.workflows.length) {
      const names = new Set(doc.workflows.map((w) => w.name));
      const active = got.workflows.filter((w) => names.has(w.name) && w.sourceEnabled);
      checks.push({ name: "Imported routines are paused", ok: active.length === 0, detail: active.length ? `${active.length} routine(s) are active` : undefined });
    }
    return checks;
  }
};
