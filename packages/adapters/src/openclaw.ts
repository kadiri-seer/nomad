import { basename, join, relative } from "node:path";
import JSON5 from "json5";
import type { AgentDocument, PermissionPolicy, PermissionRule, Workflow } from "@nomad/schema";
import {
  createDocument,
  extractBlock,
  findAgentIdMarker,
  removeBlocks,
  slugify,
  type Adapter,
  type AgentRef,
  type DesiredFile,
  type Note,
  type PlannedWrite,
  type VerifyCheck,
  type WriteContext
} from "@nomad/core";
import { expandHome, home, listDir, pathExists, readTextIfExists } from "@nomad/core/node";
import { OPENCLAW_INFO } from "./catalog";
import {
  bareModel,
  nomadBlockKey,
  parseAgentMarkdown,
  parseMixedMemory,
  qualifiedModel,
  readSkillsTree,
  renderAgentMarkdown,
  renderMemoryMarkdown,
  rule,
  safeName,
  skillToFiles,
  wants,
  workflowPrompt
} from "./util";

const P = "openclaw";

interface OcAgent {
  id: string;
  name?: string;
  workspace?: string;
  model?: string | { primary?: string; fallbacks?: string[] };
  identity?: { name?: string; emoji?: string; theme?: string };
  tools?: { allow?: string[]; deny?: string[] };
  default?: boolean;
  [k: string]: unknown;
}

async function loadConfig(root: string, notes: Note[]): Promise<{ cfg: any; exists: boolean }> {
  const text = await readTextIfExists(join(root, "openclaw.json"));
  if (text === null) return { cfg: {}, exists: false };
  try {
    return { cfg: JSON5.parse(text) ?? {}, exists: true };
  } catch (e) {
    notes.push({ level: "error", message: `openclaw.json could not be parsed: ${(e as Error).message}` });
    return { cfg: {}, exists: true };
  }
}

function agentsList(cfg: any): OcAgent[] {
  return Array.isArray(cfg?.agents?.list) ? cfg.agents.list.filter((a: any) => a && typeof a.id === "string") : [];
}

function defaultAgentId(cfg: any): string {
  const list = agentsList(cfg);
  return (list.find((a) => a.default) ?? list[0])?.id ?? "main";
}

function defaultWorkspace(cfg: any, root: string): string {
  const w = cfg?.agents?.defaults?.workspace ?? cfg?.agent?.workspace;
  return typeof w === "string" ? expandHome(w) : join(root, "workspace");
}

function workspaceFor(cfg: any, root: string, agentId: string): string {
  const entry = agentsList(cfg).find((a) => a.id === agentId);
  if (entry?.workspace) return expandHome(entry.workspace);
  if (agentId === defaultAgentId(cfg)) return defaultWorkspace(cfg, root);
  return join(root, `workspace-${agentId}`);
}

function modelOf(cfg: any, agentId: string): { primary?: string; fallbacks: string[] } {
  const entry = agentsList(cfg).find((a) => a.id === agentId);
  const m = entry?.model ?? cfg?.agents?.defaults?.model ?? cfg?.agent?.model;
  if (typeof m === "string") return { primary: m, fallbacks: [] };
  if (m && typeof m === "object") return { primary: m.primary, fallbacks: Array.isArray(m.fallbacks) ? m.fallbacks : [] };
  return { fallbacks: [] };
}

/* ------------------------------ tools policy ------------------------------ */

const OC_TOOLS: Record<string, PermissionRule["capability"]> = {
  exec: "shell",
  process: "shell",
  bash: "shell",
  read: "read",
  write: "write",
  edit: "write",
  apply_patch: "write",
  browser: "browser",
  web_fetch: "network",
  web_search: "network",
  cron: "schedule",
  nodes: "computer",
  message: "integration"
};
const CAP_TOOLS: Partial<Record<PermissionRule["capability"], string[]>> = {
  shell: ["exec", "process"],
  read: ["read"],
  write: ["write", "edit", "apply_patch"],
  browser: ["browser"],
  network: ["web_fetch", "web_search"],
  schedule: ["cron"],
  computer: ["nodes"]
};

function policyFromTools(tools: { allow?: string[]; deny?: string[] } | undefined): PermissionPolicy {
  const rules: PermissionRule[] = [];
  for (const effect of ["allow", "deny"] as const) {
    for (const t of tools?.[effect] ?? []) {
      const cap = OC_TOOLS[t];
      rules.push(cap ? rule(cap, effect, undefined, `openclaw:tools.${effect}=${t}`) : rule("tool", effect, t, `openclaw:tools.${effect}=${t}`));
    }
  }
  return { mode: "ask", rules, notes: tools?.allow?.length ? ["OpenClaw tools.allow restricts the agent to the listed tools."] : [] };
}

/* ------------------------------ identity ------------------------------ */

function parseIdentityMd(text: string) {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^\s*[-*]?\s*\*\*(Name|Emoji|Vibe|Creature|Avatar|Theme):\*\*\s*(.+?)\s*$/gim)) {
    const v = m[2].trim();
    if (v && !/^_?\(.*\)_?$/.test(v)) out[m[1].toLowerCase()] = v;
  }
  return out;
}

function renderIdentityMd(doc: AgentDocument): string {
  const lines = ["# IDENTITY.md - Who Am I?", "", `- **Name:** ${doc.identity.name}`];
  if (doc.identity.emoji) lines.push(`- **Emoji:** ${doc.identity.emoji}`);
  if (doc.identity.tone) lines.push(`- **Vibe:** ${doc.identity.tone}`);
  const ext = doc.identity.extensions?.["x-openclaw"] as any;
  if (ext?.creature) lines.push(`- **Creature:** ${ext.creature}`);
  if (doc.identity.description) lines.push("", doc.identity.description);
  lines.push("", `<!-- nomad:agent=${doc.id} -->`);
  return lines.join("\n") + "\n";
}

/* ------------------------------ cron ------------------------------ */

function jobsOf(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.jobs)) return raw.jobs;
  return [];
}

function workflowFromJob(job: any): Workflow | null {
  const s = job.schedule ?? {};
  let trigger: Workflow["trigger"];
  if (s.kind === "cron" && typeof s.expr === "string") trigger = { kind: "cron", expr: s.expr };
  else if (s.kind === "every" && Number(s.everyMs) > 0) trigger = { kind: "interval", everyMs: Number(s.everyMs) };
  else if (s.kind === "at" && (s.at || s.atMs)) trigger = { kind: "once", at: s.at ?? new Date(Number(s.atMs)).toISOString() };
  else return null;
  const text = job.payload?.message ?? job.payload?.text ?? "";
  return {
    id: String(job.id ?? job.name),
    name: String(job.name ?? job.id ?? "Routine"),
    description: job.description,
    trigger,
    timezone: typeof s.tz === "string" ? s.tz : undefined,
    actions: [{ kind: "prompt", text: String(text) }],
    requiredTools: [],
    dependencies: [],
    conditions: [],
    delivery: job.delivery?.channel ? `${job.delivery.channel}${job.delivery.to ? ":" + job.delivery.to : ""}` : undefined,
    sourceEnabled: job.enabled !== false,
    enabled: false,
    source: { platform: P, path: "cron/jobs.json" },
    "x-openclaw": { sessionTarget: job.sessionTarget, wakeMode: job.wakeMode, payloadKind: job.payload?.kind }
  } as Workflow;
}

function jobFromWorkflow(w: Workflow, agentId: string | undefined): Record<string, unknown> {
  const ext = ((w as any)["x-openclaw"] ?? {}) as any;
  let schedule: Record<string, unknown>;
  switch (w.trigger.kind) {
    case "cron":
      schedule = { kind: "cron", expr: w.trigger.expr, ...(w.timezone ? { tz: w.timezone } : {}) };
      break;
    case "interval":
      schedule = { kind: "every", everyMs: w.trigger.everyMs };
      break;
    case "once":
      schedule = { kind: "at", at: w.trigger.at };
      break;
    default:
      throw new Error("unsupported trigger");
  }
  const main = ext.sessionTarget === "main" && ext.payloadKind === "systemEvent";
  const text = workflowPrompt(w.actions);
  return {
    id: w.source?.platform === P ? w.id : `nomad-${safeName(w.id)}`,
    ...(agentId ? { agentId } : {}),
    name: w.name,
    ...(w.description ? { description: w.description } : {}),
    enabled: false,
    createdAtMs: Date.now(),
    schedule,
    sessionTarget: main ? "main" : "isolated",
    wakeMode: ext.wakeMode ?? "next-heartbeat",
    payload: main ? { kind: "systemEvent", text } : { kind: "agentTurn", message: text }
  };
}

/* ------------------------------ read ------------------------------ */

async function readAgent(root: string, agentId: string, notes: Note[], prefer?: string) {
  const { cfg } = await loadConfig(root, notes);
  const ws = workspaceFor(cfg, root, agentId);
  const sourceFiles: string[] = [];
  const entry = agentsList(cfg).find((a) => a.id === agentId);
  const doc = createDocument({ name: entry?.name ?? entry?.identity?.name ?? agentId, platform: P });
  doc.source.location = ws;
  doc.source.nativeId = agentId;
  const read = async (f: string) => {
    const p = join(ws, f);
    const t = await readTextIfExists(p);
    if (t !== null) sourceFiles.push(p);
    return t;
  };

  const identity = await read("IDENTITY.md");
  if (identity) {
    const id = parseIdentityMd(identity);
    if (id.name) {
      doc.name = id.name;
      doc.identity.name = id.name;
    }
    if (id.emoji) doc.identity.emoji = id.emoji;
    if (id.vibe) doc.identity.tone = id.vibe;
    if (id.creature) doc.identity.extensions = { "x-openclaw": { creature: id.creature } };
    const marker = findAgentIdMarker(identity, prefer);
    if (marker) doc.id = marker;
  }
  if (entry?.identity?.emoji && !doc.identity.emoji) doc.identity.emoji = entry.identity.emoji;

  const soul = await read("SOUL.md");
  if (soul?.trim()) doc.identity.persona = removeBlocks(soul).trim() || soul.trim();

  const parseInstrFile = async (file: string, kind: AgentDocument["instructions"][number]["kind"], id: string) => {
    const text = await read(file);
    if (text === null) return;
    const marker = findAgentIdMarker(text, prefer);
    if (marker && !identity) doc.id = marker;
    const block = marker ? extractBlock(text, `agent=${marker}`) : null;
    if (block) {
      const parsed = parseAgentMarkdown(block, P, file);
      doc.instructions.push(...parsed.instructions);
      doc.memory.push(...parsed.memory);
    }
    const outside = removeBlocks(text).trim();
    if (outside) doc.instructions.push({ id, kind, title: file, content: outside, source: { platform: P, path: file } });
  };
  await parseInstrFile("AGENTS.md", "agent", "agents-md");
  await parseInstrFile("TOOLS.md", "conventions", "tools-md");
  await parseInstrFile("HEARTBEAT.md", "heartbeat", "heartbeat-md");
  await parseInstrFile("BOOT.md", "bootstrap", "boot-md");

  const user = await read("USER.md");
  if (user !== null) {
    const marker = findAgentIdMarker(user, prefer);
    const block = marker ? extractBlock(user, `agent=${marker}`) : null;
    if (block) {
      const parsed = parseAgentMarkdown(block, P, "USER.md");
      doc.instructions.push(...parsed.instructions);
      doc.memory.push(...parsed.memory);
    }
    const outside = removeBlocks(user).trim();
    if (outside) doc.memory.push(...parseMixedMemory(outside, { platform: P, path: "USER.md", defaultKind: "profile", scope: "user", idPrefix: "user" }));
  }
  const memory = await read("MEMORY.md");
  if (memory !== null) doc.memory.push(...parseMixedMemory(memory, { platform: P, path: "MEMORY.md", defaultKind: "fact", scope: "agent", idPrefix: "memory" }));
  for (const e of await listDir(join(ws, "memory"))) {
    if (!e.file || !e.name.endsWith(".md")) continue;
    const text = (await read(`memory/${e.name}`))!;
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(e.name)?.[1];
    const marker = /<!-- nomad:memory id=("[^"]*"|\S+)/.exec(text)?.[1]?.replace(/"/g, "");
    doc.memory.push({
      id: marker ?? `daily-${e.name.replace(/\.md$/, "")}`,
      kind: date ? "daily-log" : "note",
      scope: "agent",
      title: date ? `Log ${date}` : e.name.replace(/\.md$/, ""),
      content: text.replace(/<!-- nomad:memory [^>]*-->\n?/g, "").trim(),
      date,
      tags: [],
      source: { platform: P, path: `memory/${e.name}` }
    });
  }

  doc.skills.push(...(await readSkillsTree(join(ws, "skills"), P, notes, 1)));

  const m = modelOf(cfg, agentId);
  if (m.primary) doc.models.preferred = m.primary;
  doc.models.fallbacks = m.fallbacks;
  if (m.primary?.includes("/")) doc.models.provider = m.primary.split("/")[0];

  const tools = entry?.tools ?? cfg?.tools;
  if (tools?.allow?.length || tools?.deny?.length) doc.permissions = policyFromTools(tools);

  const jobsText = await readTextIfExists(join(root, "cron", "jobs.json"));
  if (jobsText) {
    try {
      const jobs = jobsOf(JSON.parse(jobsText));
      const isDefault = agentId === defaultAgentId(cfg);
      for (const j of jobs) {
        if (j.agentId ? j.agentId !== agentId : !isDefault) continue;
        const w = workflowFromJob(j);
        if (w) doc.workflows.push(w);
        else notes.push({ level: "warning", category: "workflows", message: `Cron job ${j.id ?? j.name} has an unrecognised schedule and was skipped.` });
      }
      sourceFiles.push(join(root, "cron", "jobs.json"));
    } catch (e) {
      notes.push({ level: "warning", category: "workflows", message: `cron/jobs.json could not be parsed: ${(e as Error).message}` });
    }
  }
  if (cfg?.channels && Object.keys(cfg.channels).length) {
    for (const ch of Object.keys(cfg.channels)) doc.integrations.push({ name: ch, kind: "channel", requiresAuth: true, config: {}, notes: "Messaging channel. Credentials are not migrated.", source: { platform: P, path: "openclaw.json" } });
  }
  if (await pathExists(join(root, "openclaw.json"))) sourceFiles.push(join(root, "openclaw.json"));
  return { doc, sourceFiles };
}

/* ------------------------------ plan ------------------------------ */

async function planAgent(doc: AgentDocument, ctx: WriteContext): Promise<PlannedWrite> {
  const notes: Note[] = [];
  const { cfg, exists } = await loadConfig(ctx.root, notes);
  const list = agentsList(cfg);
  let agentId: string;
  let newEntry: OcAgent | null = null;
  if (ctx.mode === "copy") {
    const base = slugify(ctx.targetName ?? doc.name);
    agentId = base;
    let i = 2;
    while (list.some((a) => a.id === agentId) || agentId === "main") agentId = `${base}-${i++}`;
    const wsPath = join(ctx.root, `workspace-${agentId}`);
    const h = home();
    newEntry = { id: agentId, name: ctx.targetName ?? doc.name, workspace: wsPath.startsWith(h) ? "~/" + relative(h, wsPath) : wsPath };
  } else {
    agentId = ctx.targetNativeId ?? defaultAgentId(cfg);
  }
  const ws = newEntry ? expandHome(newEntry.workspace!) : workspaceFor(cfg, ctx.root, agentId);
  const W = { root: ws };
  const files: DesiredFile[] = [];
  const manualSteps: string[] = [];
  const conversions: PlannedWrite["conversions"] = [];
  const unsupported: PlannedWrite["unsupported"] = [];
  const key = nomadBlockKey(doc);
  const wsFile = (path: string, f: Omit<DesiredFile, "path" | "root">): DesiredFile => ({ ...f, path, root: W.root });

  files.push(wsFile("IDENTITY.md", { content: renderIdentityMd(doc), strategy: "replace", component: "identity", description: "Agent name, emoji and vibe" }));
  if (doc.identity.persona) files.push(wsFile("SOUL.md", { content: doc.identity.persona.trim() + "\n", strategy: "replace", component: "identity", description: "Persona" }));

  if (wants(ctx, "instructions")) {
    const groups: Array<[string, AgentDocument["instructions"][number]["kind"][]]> = [
      ["AGENTS.md", ["system", "agent", "custom", "command", "bootstrap"]],
      ["TOOLS.md", ["conventions"]],
      ["HEARTBEAT.md", ["heartbeat"]]
    ];
    for (const [file, kinds] of groups) {
      const items = doc.instructions.filter((i) => kinds.includes(i.kind) && i.content.trim());
      if (!items.length) continue;
      files.push(wsFile(file, { content: renderAgentMarkdown({ ...doc, instructions: items }, { includePersona: false, heading: false }), strategy: "managed-block", blockKey: key, component: "instructions", description: `${items.length} instruction section(s) in ${file}` }));
    }
  }

  const profile = wants(ctx, "memory") ? doc.memory.filter((m) => m.scope === "user" || m.kind === "profile") : [];
  const userCtx = wants(ctx, "instructions") ? doc.instructions.filter((i) => i.kind === "user-context") : [];
  if (profile.length || userCtx.length) {
    files.push(wsFile("USER.md", { content: renderAgentMarkdown({ ...doc, instructions: userCtx, memory: profile }, { includePersona: false, includeMemory: true, heading: false }), strategy: "managed-block", blockKey: key, component: "memory", description: `About the user (${profile.length} memory entries)` }));
  }
  if (wants(ctx, "memory")) {
    const longTerm = doc.memory.filter((m) => !profile.includes(m) && m.kind !== "daily-log");
    if (longTerm.length) files.push(wsFile("MEMORY.md", { content: renderMemoryMarkdown(longTerm), strategy: "managed-block", blockKey: key, component: "memory", description: `${longTerm.length} long-term memory entries` }));
    for (const m of doc.memory.filter((x) => x.kind === "daily-log")) {
      const name = m.date ? `${m.date}.md` : `nomad-${safeName(m.id)}.md`;
      files.push(wsFile(`memory/${name}`, { content: `<!-- nomad:memory id=${JSON.stringify(m.id)} -->\n${m.content.trim()}\n`, strategy: "create-only", component: "memory", description: `Daily log ${m.date ?? m.id}` }));
    }
  }
  if (wants(ctx, "skills")) {
    for (const s of doc.skills) {
      const { "x-claude-code-command": c, "x-codex-prompt": p, ...fm } = s.frontmatter;
      if (c || p) conversions.push({ category: "skills", item: s.name, from: c ? "Claude Code slash command" : "Codex custom prompt", to: "OpenClaw skill (manual invocation)" });
      files.push(...skillToFiles({ ...s, frontmatter: fm, invocation: c || p ? "manual" : s.invocation }, "skills").map((f) => ({ ...f, root: W.root })));
    }
  }

  // cron jobs (always disabled on import)
  if (wants(ctx, "workflows") && doc.workflows.length) {
    const jobs: Record<string, unknown>[] = [];
    for (const w of doc.workflows) {
      if (w.trigger.kind === "event" || w.trigger.kind === "manual") {
        unsupported.push({ category: "workflows", item: w.name, reason: `OpenClaw cron cannot run ${w.trigger.kind} triggers.`, alternative: "Turn it into a skill or a heartbeat checklist item." });
        continue;
      }
      jobs.push(jobFromWorkflow(w, list.length || newEntry ? agentId : undefined));
    }
    if (jobs.length) {
      const existing = await readTextIfExists(join(ctx.root, "cron", "jobs.json"));
      let bare = false;
      try {
        bare = existing ? Array.isArray(JSON.parse(existing)) : false;
      } catch {
        /* reported by the engine */
      }
      files.push({
        path: "cron/jobs.json",
        content: JSON.stringify(bare ? jobs : { version: 1, jobs }, null, 2) + "\n",
        strategy: "merge-json",
        arrayKeys: bare ? { "": "id" } : { jobs: "id" },
        component: "workflows",
        description: `${jobs.length} cron job(s), imported disabled`
      });
      manualSteps.push(`Review the imported routines and enable them with "openclaw cron enable <id>" when ready.`);
    }
  }

  // openclaw.json
  const cfgPatch: any = {};
  const targetEntry: OcAgent | null = newEntry ?? (list.find((a) => a.id === agentId) ? { id: agentId } : null);
  if (wants(ctx, "models") && doc.models.preferred) {
    const primary = qualifiedModel(doc.models.preferred, doc.models.provider);
    const model = doc.models.fallbacks.length ? { primary, fallbacks: doc.models.fallbacks.map((f) => qualifiedModel(f)) } : primary;
    if (targetEntry) targetEntry.model = model;
    else cfgPatch.agents = { defaults: { model: { primary } } };
    if (primary !== doc.models.preferred) conversions.push({ category: "models", item: doc.models.preferred, from: bareModel(primary), to: primary });
    manualSteps.push(`Make sure OpenClaw has credentials for ${primary.split("/")[0]} ("openclaw configure").`);
  }
  if (wants(ctx, "permissions")) {
    const deny = new Set<string>();
    for (const r of doc.permissions.rules) {
      if (r.effect === "allow") continue;
      const native = r.source?.startsWith("openclaw:tools.deny=") ? [r.source.split("=")[1]] : !r.pattern ? CAP_TOOLS[r.capability] : undefined;
      if (r.effect === "deny" && native) native.forEach((t) => deny.add(t));
      else unsupported.push({ category: "permissions", item: `${r.effect} ${r.capability}${r.pattern ? ` (${r.pattern})` : ""}`, reason: r.effect === "ask" ? "OpenClaw tool policy cannot require approval per tool." : "No matching OpenClaw tool.", alternative: "Documented in the report. Exec approvals can be configured with openclaw approvals." });
    }
    if (doc.permissions.mode === "read-only") CAP_TOOLS.write!.concat(CAP_TOOLS.shell!).forEach((t) => deny.add(t));
    if (deny.size) {
      if (targetEntry) targetEntry.tools = { deny: [...deny] };
      else cfgPatch.tools = { deny: [...deny] };
      conversions.push({ category: "permissions", item: "restrictions", from: "deny rules", to: `tools.deny: ${[...deny].join(", ")}` });
    }
    const allows = doc.permissions.rules.filter((r) => r.effect === "allow" && !r.source?.startsWith("openclaw:"));
    if (allows.length) notes.push({ level: "info", category: "permissions", message: `${allows.length} allow rule(s) are documented but not applied, so the agent gets no new privileges.` });
  }
  if (targetEntry) {
    const listPatch: OcAgent[] = [];
    if (newEntry && !list.length) listPatch.push({ id: defaultAgentId(cfg), default: true });
    listPatch.push(targetEntry);
    if (Object.keys(targetEntry).length > 1 || newEntry) cfgPatch.agents = { ...(cfgPatch.agents ?? {}), list: listPatch };
  }
  if (Object.keys(cfgPatch).length) {
    files.push({ path: "openclaw.json", content: JSON.stringify(cfgPatch, null, 2) + "\n", strategy: "merge-json5", arrayKeys: { "agents.list": "id" }, component: "project", description: newEntry ? `Register agent "${agentId}" in openclaw.json` : "Model and tool policy in openclaw.json" });
    if (exists) notes.push({ level: "info", message: "openclaw.json is rewritten as JSON. Comments in it are not kept (a backup is taken first)." });
  }

  if (wants(ctx, "tools")) {
    for (const t of doc.tools) {
      unsupported.push({ category: "tools", item: t.name, reason: "OpenClaw connects MCP servers through plugins, which Nomad does not install.", alternative: "Install an MCP bridge plugin and add the server; its definition is in the report." });
      if (t.mcp) manualSteps.push(`Add the "${t.name}" MCP server (${t.mcp.command ?? t.mcp.url ?? ""} ${t.mcp.args.join(" ")}) through your OpenClaw MCP plugin.`.replace(/\s+\)/, ")"));
    }
  }
  if (wants(ctx, "integrations")) for (const i of doc.integrations) manualSteps.push(`Reconnect ${i.name} in OpenClaw (credentials are never migrated).`);
  if (wants(ctx, "knowledge") && (doc.knowledge.length || doc.files.length)) manualSteps.push(`Copy ${doc.knowledge.length + doc.files.length} knowledge file(s) into the workspace.`);
  if (newEntry) notes.push({ level: "info", message: `A new agent "${agentId}" with its own workspace will be created. Restart the gateway to load it.` });
  return { nativeId: agentId, files, notes, manualSteps, conversions, unsupported };
}

export const openclawAdapter: Adapter = {
  info: OPENCLAW_INFO,

  async detect(root) {
    const evidence: string[] = [];
    for (const f of ["openclaw.json", "workspace", "cron", "agents", "credentials"]) if (await pathExists(join(root, f))) evidence.push(f);
    const strong = evidence.includes("openclaw.json") || (basename(root) === ".openclaw" && evidence.length > 0);
    return { detected: strong, confidence: strong ? 0.95 : 0, evidence };
  },

  async discover(root) {
    const notes: Note[] = [];
    const { cfg, exists } = await loadConfig(root, notes);
    const list = agentsList(cfg);
    const refs: AgentRef[] = [];
    const ids = list.length ? list.map((a) => a.id) : exists || (await pathExists(join(root, "workspace"))) ? ["main"] : [];
    for (const id of ids) {
      const ws = workspaceFor(cfg, root, id);
      const identity = await readTextIfExists(join(ws, "IDENTITY.md"));
      const name = (identity && parseIdentityMd(identity).name) || list.find((a) => a.id === id)?.name || id;
      refs.push({ nativeId: id, name, description: `Workspace ${ws}`, location: ws, kind: "workspace" });
    }
    return refs;
  },

  async read(root, nativeId, options = {}) {
    const notes: Note[] = [];
    const r = await readAgent(root, nativeId, notes, options.agentId);
    return { ...r, notes };
  },

  plan: planAgent,

  async readPolicy(root, nativeId) {
    const { cfg } = await loadConfig(root, []);
    const entry = agentsList(cfg).find((a) => a.id === (nativeId ?? defaultAgentId(cfg)));
    const tools = entry?.tools ?? cfg?.tools;
    return tools ? policyFromTools(tools) : { mode: "ask", rules: [], notes: [] };
  },

  async verify(doc, root, nativeId, ctx) {
    const checks: VerifyCheck[] = [];
    const notes: Note[] = [];
    await loadConfig(root, notes);
    checks.push({ name: "openclaw.json parses", ok: !notes.some((n) => n.level === "error"), detail: notes[0]?.message });
    const got = (await readAgent(root, nativeId, [], doc.id)).doc;
    if (ctx.mode !== "merge") checks.push({ name: "Agent identity preserved", ok: got.id === doc.id && got.identity.name === doc.identity.name });
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
      const missing = doc.skills.filter((s) => !names.has(s.name));
      checks.push({ name: "Skills written", ok: !missing.length, detail: missing.length ? `Missing: ${missing.map((s) => s.name).join(", ")}` : undefined });
    }
    if (wants(ctx, "workflows") && doc.workflows.length) {
      const active = got.workflows.filter((w) => w.sourceEnabled && doc.workflows.some((d) => d.name === w.name));
      checks.push({ name: "Imported routines are disabled", ok: active.length === 0, detail: active.length ? `${active.length} routine(s) are enabled` : undefined });
    }
    return checks;
  }
};
