import { AgentDocument, type MemoryEntry, type PermissionRule, type Workflow, UAF_SCHEMA_VERSION, validateDocument, type ValidationIssue } from "@nomad/schema";
import { base64Decode, base64Encode, fromUtf8, isUlid, parseFrontmatter, slugify, ulid, utf8 } from "@nomad/core";

/**
 * Interchange archives (.jetpack): a flat agent layout used by other agent
 * portability tools. Nomad reads them on import and can write them on export,
 * so agents move in and out of Nomad without loss of the parts the layout has.
 *
 *   jetpack.json        manifest (schema 0.1)
 *   AGENTS.md           instructions
 *   SOUL.md             persona
 *   MEMORY.md           "- " lines are facts, other lines are prose
 *   memory/<name>.md    notes
 *   routines/<x>.json   { name, instruction, enabled, timezone, schedule }
 *   skills/<name>/...   Agent Skills folders
 *   files/...           other files
 *
 * Parts the layout has no place for (MCP tools, integrations, structured memory
 * metadata) travel in a namespaced manifest key that other readers ignore.
 */

export const INTERCHANGE_EXTENSION = ".jetpack";
export const INTERCHANGE_MANIFEST = "jetpack.json";
const SCHEMA = "0.1";
const EXT_KEY = "x-nomad";
const MAX_FACT = 500;
const MAX_SKILLS = 32;
const MAX_ROUTINES = 64;

type Rule = { effect: "allow" | "deny" | "ask"; on: string; tool?: string; pattern?: string };

const ON_TO_CAP: Record<string, PermissionRule["capability"]> = {
  shell: "shell",
  "files.read": "read",
  "files.write": "write",
  network: "network",
  browser: "browser",
  computerUse: "computer",
  scheduler: "schedule",
  tool: "tool"
};

const CAP_TO_ON: Partial<Record<PermissionRule["capability"], string>> = {
  shell: "shell",
  read: "files.read",
  write: "files.write",
  network: "network",
  browser: "browser",
  computer: "computerUse",
  schedule: "scheduler",
  tool: "tool"
};

export function isInterchange(files: Map<string, Uint8Array>): boolean {
  return files.has(INTERCHANGE_MANIFEST) && !files.has("manifest.json");
}

function everyToMs(every: string): number | null {
  const m = /^([1-9]\d*)(m|h|d)$/.exec(every);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
}

function msToEvery(ms: number): string | null {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const) {
    if (ms % size === 0 && ms >= size) return `${ms / size}${unit}`;
  }
  return null;
}

function encode(data: Uint8Array, path: string) {
  const text = /\.(md|txt|json|ya?ml|toml|py|sh|js|ts|mjs|csv|html|css|svg)$/i.test(path) ? fromUtf8(data) : null;
  return text !== null && !text.includes("�") ? { encoding: "utf8" as const, content: text } : { encoding: "base64" as const, content: base64Encode(data) };
}

export interface InterchangeReadResult {
  doc: AgentDocument | null;
  issues: ValidationIssue[];
  warnings: string[];
}

/** Read an interchange archive into a Nomad document. */
export function readInterchange(files: Map<string, Uint8Array>, options: { fallbackName?: string } = {}): InterchangeReadResult {
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  const text = (p: string) => (files.has(p) ? fromUtf8(files.get(p)!) : undefined);

  let manifest: any = {};
  if (files.has(INTERCHANGE_MANIFEST)) {
    try {
      manifest = JSON.parse(text(INTERCHANGE_MANIFEST)!);
    } catch (e) {
      return { doc: null, issues: [{ path: INTERCHANGE_MANIFEST, message: `Invalid JSON: ${(e as Error).message}` }], warnings };
    }
    if (manifest.schemaVersion !== SCHEMA) issues.push({ path: `${INTERCHANGE_MANIFEST}.schemaVersion`, message: `Unsupported interchange version ${manifest.schemaVersion}` });
    if (typeof manifest.name !== "string" || !manifest.name) issues.push({ path: `${INTERCHANGE_MANIFEST}.name`, message: "Missing agent name" });
    if (issues.length) return { doc: null, issues, warnings };
  } else if (!files.has("AGENTS.md")) {
    return { doc: null, issues: [{ path: "(archive)", message: "Neither jetpack.json nor AGENTS.md was found" }], warnings };
  }

  const ext = (manifest[EXT_KEY] ?? {}) as any;
  const now = new Date().toISOString();
  const name: string = manifest.name ?? options.fallbackName ?? "Imported agent";
  const id = isUlid(manifest.id) ? manifest.id : ulid();

  // Instructions: Nomad-written sections round trip, anything else is one section.
  const agentsMd = text("AGENTS.md") ?? "";
  const instructions: AgentDocument["instructions"] = Array.isArray(ext.instructions)
    ? ext.instructions
    : agentsMd.trim()
      ? [{ id: "agents-md", kind: "agent", title: "AGENTS.md", content: agentsMd.trim(), source: { platform: "interchange", path: "AGENTS.md" } }]
      : [];
  if (Array.isArray(ext.instructions)) {
    const joined = ext.instructions.map((i: any) => i.content.trim()).join("\n\n");
    if (joined !== agentsMd.trim()) {
      warnings.push("AGENTS.md was edited after export; its current text was used.");
      instructions.splice(0, instructions.length, { id: "agents-md", kind: "agent", title: "AGENTS.md", content: agentsMd.trim(), source: { platform: "interchange", path: "AGENTS.md" } });
    }
  }

  // Memory: facts and notes, enriched by stored metadata when present.
  const meta = new Map<string, any>((Array.isArray(ext.memory) ? ext.memory : []).map((m: any) => [m.content, m]));
  const memory: MemoryEntry[] = [];
  const memText = text("MEMORY.md");
  if (memText) {
    const prose: string[] = [];
    let n = 0;
    for (const line of memText.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("- ")) {
        const content = t.slice(2).trim();
        const m = meta.get(content);
        memory.push(m ? { ...m, content } : { id: `fact-${++n}`, kind: "fact", scope: "agent", content, tags: [], source: { platform: "interchange", path: "MEMORY.md" } });
      } else prose.push(line.trimEnd());
    }
    if (prose.length) memory.push({ id: "memory-prose", kind: "note", scope: "agent", title: "Memory notes", content: prose.join("\n"), tags: [], source: { platform: "interchange", path: "MEMORY.md" } });
  }
  for (const [p] of files) {
    const m = /^memory\/([^/]+)\.md$/.exec(p);
    if (!m) continue;
    const content = text(p)!.trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(m[1]) ? m[1] : undefined;
    const stored = meta.get(content);
    memory.push(stored ? { ...stored, content } : { id: `note-${m[1]}`, kind: date ? "daily-log" : "note", scope: "agent", title: m[1], content, date, tags: [], source: { platform: "interchange", path: p } });
  }

  // Skills
  const skillFiles = new Map<string, Array<[string, Uint8Array]>>();
  for (const [p, d] of files) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(p);
    if (!m) continue;
    if (!skillFiles.has(m[1])) skillFiles.set(m[1], []);
    skillFiles.get(m[1])!.push([m[2], d]);
  }
  const skills: AgentDocument["skills"] = [];
  for (const [dir, list] of skillFiles) {
    const main = list.find(([p]) => p === "SKILL.md");
    if (!main) {
      warnings.push(`Skill folder ${dir} has no SKILL.md and was skipped.`);
      continue;
    }
    const fm = parseFrontmatter(fromUtf8(main[1]));
    const { name: sname, description, ...rest } = fm.data as Record<string, any>;
    const allowed = rest["allowed-tools"];
    delete rest["allowed-tools"];
    skills.push({
      name: typeof sname === "string" ? sname : dir,
      description: typeof description === "string" ? description : "",
      instructions: fm.body.replace(/^\n+/, ""),
      dependencies: [],
      platforms: [],
      allowedTools: typeof allowed === "string" ? allowed.split(/,\s*/) : Array.isArray(allowed) ? allowed : [],
      config: {},
      references: [],
      files: list.filter(([p]) => p !== "SKILL.md").map(([p, d]) => ({ path: p, ...encode(d, p), executable: /\.(sh|py|js|mjs|ts|rb)$/i.test(p) })),
      frontmatter: rest,
      invocation: rest["disable-model-invocation"] === true ? "manual" : "auto",
      source: { platform: "interchange", path: `skills/${dir}/SKILL.md` }
    });
  }

  // Routines (always imported disabled; the source state is kept)
  const workflows: Workflow[] = [];
  for (const [p] of files) {
    if (!/^routines\/[^/]+\.json$/.test(p)) continue;
    let r: any;
    try {
      r = JSON.parse(text(p)!);
    } catch {
      warnings.push(`${p} is not valid JSON and was skipped.`);
      continue;
    }
    let trigger: Workflow["trigger"] | null = null;
    if (r.schedule?.kind === "cron" && r.schedule.expression) trigger = { kind: "cron", expr: r.schedule.expression };
    else if (r.schedule?.kind === "every" && everyToMs(String(r.schedule.every))) trigger = { kind: "interval", everyMs: everyToMs(String(r.schedule.every))! };
    else if (r.schedule?.kind === "at" && r.schedule.at) trigger = { kind: "once", at: r.schedule.at };
    if (!trigger || !r.name || !r.instruction) {
      warnings.push(`${p} has an unrecognised routine and was skipped.`);
      continue;
    }
    workflows.push({ id: slugify(r.name), name: r.name, trigger, timezone: r.timezone, actions: [{ kind: "prompt", text: r.instruction }], requiredTools: [], dependencies: [], conditions: [], sourceEnabled: !!r.enabled, enabled: false, source: { platform: "interchange", path: p } });
  }

  // Policy
  const rules: PermissionRule[] = [];
  for (const r of (manifest.policy?.rules ?? []) as Rule[]) {
    const cap = ON_TO_CAP[r.on];
    if (!cap) continue;
    rules.push({ capability: cap, effect: r.effect, ...(r.on === "tool" && r.tool ? { pattern: r.tool } : r.pattern ? { pattern: r.pattern } : {}) });
  }
  const mode = manifest.policy?.mode === "readOnly" ? "read-only" : manifest.policy?.mode === "auto" ? "auto" : "ask";

  const files_: AgentDocument["files"] = [];
  for (const [p, d] of files) {
    if (p.startsWith("files/")) files_.push({ path: p.slice(6), ...encode(d, p), executable: false });
  }
  const avatar = [...files.keys()].find((p) => /^avatar\.(png|jpe?g|webp)$/i.test(p));
  if (avatar) files_.push({ path: avatar, encoding: "base64", content: base64Encode(files.get(avatar)!), executable: false });

  const pref = Array.isArray(manifest.models) ? manifest.models[0] : undefined;
  const raw = {
    schemaVersion: UAF_SCHEMA_VERSION,
    id,
    name,
    description: manifest.description,
    createdAt: ext.createdAt ?? manifest.origin?.exportedAt ?? now,
    updatedAt: manifest.origin?.exportedAt ?? now,
    source: { platform: ext.platform ?? manifest.origin?.app ?? "interchange", platformVersion: manifest.origin?.version, readAt: now },
    identity: { name: manifest.title ?? name, description: manifest.description, persona: text("SOUL.md")?.trim() || undefined, avatar: avatar ? `files/${avatar}` : undefined, ...(ext.identity ?? {}) },
    models: { preferred: pref?.model ? (pref.provider ? `${pref.provider}/${pref.model}` : pref.model) : undefined, provider: pref?.provider, fallbacks: (manifest.models ?? []).slice(1).map((m: any) => (m.provider ? `${m.provider}/${m.model}` : m.model)).filter(Boolean) },
    instructions,
    memory,
    skills: skills.slice(0, MAX_SKILLS),
    tools: Array.isArray(ext.tools) ? ext.tools : [],
    integrations: Array.isArray(ext.integrations) ? ext.integrations : [],
    workflows,
    permissions: { mode, rules, notes: [] },
    files: files_,
    extensions: Object.fromEntries(Object.entries(manifest).filter(([k]) => k.startsWith("x-") && k !== EXT_KEY))
  };
  const v = validateDocument(raw);
  if (!v.ok) return { doc: null, issues: v.issues, warnings };
  return { doc: v.value, issues: [], warnings };
}

export interface InterchangeWriteResult {
  files: Map<string, Uint8Array>;
  /** Parts that only Nomad can read back (kept in the manifest extension). */
  carried: string[];
  dropped: string[];
}

function safeName(s: string, used: Set<string>): string {
  const base = slugify(s, "item");
  let n = base;
  let i = 2;
  while (used.has(n)) n = `${base}-${i++}`;
  used.add(n);
  return n;
}

/** Write a Nomad document as an interchange archive. */
export function writeInterchange(doc: AgentDocument, options: { exportedAt?: string } = {}): InterchangeWriteResult {
  const files = new Map<string, Uint8Array>();
  const carried: string[] = [];
  const dropped: string[] = [];
  const put = (p: string, s: string) => files.set(p, utf8(s.endsWith("\n") ? s : s + "\n"));

  const instr = doc.instructions.filter((i) => i.content.trim());
  put("AGENTS.md", instr.map((i) => i.content.trim()).join("\n\n") || `# ${doc.name}`);
  if (doc.identity.persona) put("SOUL.md", doc.identity.persona.trim());

  const facts: string[] = [];
  const usedNotes = new Set<string>();
  for (const m of doc.memory) {
    const content = m.content.trim().replace(/^[-*+]\s+/, "");
    if (!content.includes("\n") && content.length <= MAX_FACT && m.kind !== "daily-log" && m.kind !== "document") facts.push(content);
    else put(`memory/${safeName(m.date ?? m.title ?? m.id, usedNotes)}.md`, m.content.trim());
  }
  if (facts.length) put("MEMORY.md", facts.map((f) => `- ${f}`).join("\n"));

  const usedRoutines = new Set<string>();
  for (const w of doc.workflows.slice(0, MAX_ROUTINES)) {
    let schedule: Record<string, string> | null = null;
    if (w.trigger.kind === "cron") schedule = { kind: "cron", expression: w.trigger.expr };
    else if (w.trigger.kind === "interval" && msToEvery(w.trigger.everyMs)) schedule = { kind: "every", every: msToEvery(w.trigger.everyMs)! };
    else if (w.trigger.kind === "once") schedule = { kind: "at", at: new Date(w.trigger.at).toISOString() };
    if (!schedule) {
      dropped.push(`routine ${w.name} (${w.trigger.kind} trigger)`);
      continue;
    }
    const instruction = w.actions.map((a) => (a.kind === "prompt" ? a.text : a.kind === "skill" ? `Use the ${a.name} skill.` : `Run ${a.path}.`)).join("\n\n");
    put(`routines/${safeName(w.name, usedRoutines)}.json`, JSON.stringify({ name: w.name, instruction, enabled: w.sourceEnabled, timezone: w.timezone ?? "UTC", schedule }, null, 2));
  }
  if (doc.workflows.length > MAX_ROUTINES) dropped.push(`${doc.workflows.length - MAX_ROUTINES} routine(s) over the limit of ${MAX_ROUTINES}`);

  const usedSkills = new Set<string>();
  for (const s of doc.skills.slice(0, MAX_SKILLS)) {
    const dir = safeName(s.name, usedSkills);
    const fm: Record<string, unknown> = { name: s.name, description: s.description || s.name, ...(s.allowedTools.length ? { "allowed-tools": s.allowedTools.join(", ") } : {}), ...s.frontmatter };
    const yaml = Object.entries(fm)
      .filter(([, v]) => v !== undefined && typeof v !== "object")
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    put(`skills/${dir}/SKILL.md`, `---\n${yaml}\n---\n\n${s.instructions}`);
    for (const f of s.files) files.set(`skills/${dir}/${f.path}`, f.encoding === "base64" ? base64Decode(f.content) : utf8(f.content));
  }
  if (doc.skills.length > MAX_SKILLS) dropped.push(`${doc.skills.length - MAX_SKILLS} skill(s) over the limit of ${MAX_SKILLS}`);

  for (const f of doc.files) {
    if (/^avatar\.(png|jpe?g|webp)$/i.test(f.path)) files.set(f.path, base64Decode(f.content));
    else files.set(`files/${f.path}`, f.encoding === "base64" ? base64Decode(f.content) : utf8(f.content));
  }

  const capabilities = new Set<string>();
  const rules: Rule[] = [];
  for (const r of doc.permissions.rules) {
    const on = CAP_TO_ON[r.capability];
    if (!on) {
      dropped.push(`permission ${r.effect} ${r.capability}`);
      continue;
    }
    if (r.effect !== "deny") {
      if (on === "shell") capabilities.add("shell");
      if (on.startsWith("files")) capabilities.add("filesystem");
      if (on === "network") capabilities.add("network");
      if (on === "browser") capabilities.add("browser");
      if (on === "computerUse") capabilities.add("computerUse");
    }
    if (on === "tool") {
      if (r.pattern) rules.push({ effect: r.effect, on, tool: r.pattern });
      else dropped.push(`permission ${r.effect} on every tool`);
    } else rules.push({ effect: r.effect, on, ...(r.pattern ? { pattern: r.pattern } : {}) });
  }
  if (doc.workflows.length) capabilities.add("scheduler");

  const ext: Record<string, unknown> = { platform: doc.source.platform, createdAt: doc.createdAt, identity: { tone: doc.identity.tone, emoji: doc.identity.emoji } };
  if (instr.length > 1 || instr.some((i) => i.kind !== "agent")) ext.instructions = instr;
  if (doc.memory.some((m) => m.kind !== "fact" || m.title || m.tags.length)) ext.memory = doc.memory.map(({ content, ...rest }) => ({ ...rest, content: content.trim().replace(/^[-*+]\s+/, "") }));
  if (doc.tools.length) {
    ext.tools = doc.tools;
    carried.push(`${doc.tools.length} tool(s)`);
  }
  if (doc.integrations.length) {
    ext.integrations = doc.integrations;
    carried.push(`${doc.integrations.length} integration(s)`);
  }

  const split = (m: string) => (m.includes("/") ? { provider: m.split("/")[0], model: m.split("/").slice(1).join("/") } : { model: m });
  const manifest = {
    schemaVersion: SCHEMA,
    id: doc.id,
    name: doc.name.slice(0, 80),
    ...(doc.identity.name !== doc.name ? { title: doc.identity.name.slice(0, 120) } : {}),
    ...(doc.description ? { description: doc.description } : {}),
    models: [doc.models.preferred, ...doc.models.fallbacks].filter((m): m is string => !!m).map(split),
    capabilities: [...capabilities],
    origin: { app: "nomad", exportedAt: options.exportedAt ?? new Date().toISOString() },
    ...(rules.length || doc.permissions.mode !== "ask" ? { policy: { ...(doc.permissions.mode !== "ask" ? { mode: doc.permissions.mode === "read-only" ? "readOnly" : "auto" } : {}), rules } } : {}),
    [EXT_KEY]: ext
  };
  files.set(INTERCHANGE_MANIFEST, utf8(JSON.stringify(manifest, null, 2) + "\n"));
  return { files, carried, dropped };
}
