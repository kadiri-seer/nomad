import {
  type AgentDocument,
  type Instruction,
  type MemoryEntry,
  type PermissionRule,
  type Skill,
  type Tool,
  type Workflow,
  UAF_SCHEMA_VERSION,
  validateDocument,
  type ValidationIssue
} from "@nomad/schema";
import { base64Decode, base64Encode, canonicalJson, fromUtf8, NOMAD_VERSION, parseFrontmatter, sha256, slugify, stringifyFrontmatter, utf8 } from "@nomad/core";

/**
 * The .nomad package (format 2). A flat folder you can read and edit by hand:
 *
 *   nomad.json          small manifest: identity, models, policy, metadata, file hashes, signature
 *   AGENTS.md           instructions (one "## Title" section each when there are several)
 *   SOUL.md             persona
 *   MEMORY.md           memory as plain bullets grouped under headings
 *   memory/<name>.md    long entries and daily logs
 *   skills/<name>/      Agent Skills folders (SKILL.md plus files)
 *   routines/<name>.json  one routine per file: name, prompt, schedule, timezone
 *   tools.json          MCP servers in the familiar "mcpServers" shape, secrets as ${VAR}
 *   files/              knowledge files
 *
 * Everything that is not readable text (ids, kinds, scopes, provenance) lives
 * in nomad.json, so a round trip through Nomad is lossless while the files stay
 * clean. Only files that have content are written.
 */

export const NOMAD_EXTENSION = ".nomad";
export const NOMAD_MANIFEST = "nomad.json";
export const NOMAD_FORMAT = 2;

const KIND_TITLES: Record<MemoryEntry["kind"], string> = {
  profile: "About the user",
  preference: "Preferences",
  fact: "Facts",
  project: "Projects",
  instruction: "Standing instructions",
  note: "Notes",
  summary: "Summaries",
  "daily-log": "Daily log",
  document: "Documents"
};

const INSTRUCTION_TITLES: Record<Instruction["kind"], string> = {
  system: "System",
  agent: "Instructions",
  custom: "Custom instructions",
  "user-context": "About the user",
  conventions: "Conventions",
  heartbeat: "Heartbeat",
  bootstrap: "First run",
  command: "Command"
};

export interface NomadManifest {
  nomad: number;
  id: string;
  name: string;
  description?: string;
  created: string;
  updated: string;
  exported: string;
  generator: string;
  from: { platform: string; version?: string; location?: string; nativeId?: string };
  identity?: { title?: string; tone?: string; emoji?: string; avatar?: string; description?: string; extensions?: Record<string, unknown> };
  models?: string[];
  modelOptions?: { provider?: string; reasoningEffort?: string; notes?: string };
  instructions?: Array<{ id: string; kind: Instruction["kind"]; title?: string; heading?: string; from?: unknown }>;
  memory?: Array<{ id: string; kind: MemoryEntry["kind"]; scope?: MemoryEntry["scope"]; at: string; title?: string; untitled?: boolean; date?: string; tags?: string[]; dash?: boolean; from?: unknown }>;
  skills?: Record<string, Partial<Skill> & { name: string }>;
  tools?: Record<string, Partial<Tool>>;
  integrations?: AgentDocument["integrations"];
  policy?: { mode?: string; allow?: string[]; ask?: string[]; deny?: string[]; sources?: Record<string, string>; notes?: string[] };
  knowledge?: AgentDocument["knowledge"];
  history?: AgentDocument["history"];
  extensions?: Record<string, unknown>;
  secrets?: { included: boolean; redacted: number; reconnect: string[] };
  files: Record<string, string>;
  signature?: { alg: "ed25519"; key: string; fingerprint: string; value: string };
}

const nonEmpty = <T extends object>(o: T): T | undefined => (Object.values(o).some((v) => v !== undefined && !(Array.isArray(v) && !v.length) && !(v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) ? o : undefined);

function slugUnique(s: string, used: Set<string>): string {
  const base = slugify(s, "item");
  let n = base;
  let i = 2;
  while (used.has(n)) n = `${base}-${i++}`;
  used.add(n);
  return n;
}

/* ------------------------------ policy strings ------------------------------ */

function ruleString(r: PermissionRule): string {
  return r.pattern ? `${r.capability}: ${r.pattern}` : r.capability;
}

function parseRuleString(s: string, effect: PermissionRule["effect"]): PermissionRule | null {
  const m = /^([a-z]+)(?::\s*(.+))?$/.exec(s.trim());
  if (!m) return null;
  return { capability: m[1] as PermissionRule["capability"], effect, ...(m[2] ? { pattern: m[2] } : {}) };
}

/* ------------------------------ schedules ------------------------------ */

function scheduleString(t: Workflow["trigger"]): string {
  switch (t.kind) {
    case "cron":
      return t.expr;
    case "interval": {
      const ms = t.everyMs;
      for (const [u, n] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const) if (ms % n === 0) return `every ${ms / n}${u}`;
      return `every ${Math.round(ms / 1000)}s`;
    }
    case "once":
      return t.at;
    case "event":
      return `on ${t.event}`;
    case "manual":
      return "manual";
  }
}

function parseSchedule(s: string): Workflow["trigger"] | null {
  const v = s.trim();
  if (v === "manual") return { kind: "manual" };
  let m = /^on\s+(.+)$/.exec(v);
  if (m) return { kind: "event", event: m[1] };
  m = /^every\s+(\d+)\s*(s|m|h|d)$/.exec(v);
  if (m) return { kind: "interval", everyMs: Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s"] };
  if (/^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))) return { kind: "once", at: v };
  if (v.split(/\s+/).length >= 5) return { kind: "cron", expr: v };
  return null;
}

/* ------------------------------ memory rendering ------------------------------ */

function inlineable(m: MemoryEntry): boolean {
  const c = m.content.trim();
  return m.kind !== "daily-log" && m.kind !== "document" && !/\n\s*\n/.test(c) && !/\n\s/.test(c) && !/^#{1,6}\s/m.test(c) && !/^[*+]\s/.test(c) && c.length <= 2000;
}

/* ------------------------------ writer ------------------------------ */

export function writeNomadPack(doc: AgentDocument, options: { exportedAt?: string; secrets?: NomadManifest["secrets"] } = {}): { files: Map<string, Uint8Array>; manifest: NomadManifest } {
  const files = new Map<string, Uint8Array>();
  const text = (p: string, s: string) => files.set(p, utf8(s.endsWith("\n") ? s : s + "\n"));

  // Instructions
  const instr = doc.instructions.filter((i) => i.content.trim());
  let instrMeta: NomadManifest["instructions"];
  if (instr.length === 1) {
    text("AGENTS.md", instr[0].content.trim());
    instrMeta = [{ id: instr[0].id, kind: instr[0].kind, title: instr[0].title, from: fromOut(instr[0].source) }];
  } else if (instr.length > 1) {
    const used = new Set<string>();
    instrMeta = instr.map((i) => {
      let heading = i.title ?? INSTRUCTION_TITLES[i.kind];
      let n = 2;
      while (used.has(heading)) heading = `${i.title ?? INSTRUCTION_TITLES[i.kind]} (${n++})`;
      used.add(heading);
      return { id: i.id, kind: i.kind, title: i.title, heading: heading !== i.title ? heading : undefined, from: fromOut(i.source) };
    });
    text("AGENTS.md", instr.map((i, k) => `## ${instrMeta![k].heading ?? instrMeta![k].title}\n\n${i.content.trim()}`).join("\n\n"));
  }

  if (doc.identity.persona) text("SOUL.md", doc.identity.persona.trim());

  // Memory
  const memMeta: NonNullable<NomadManifest["memory"]> = [];
  const inline = doc.memory.filter(inlineable);
  const groups = new Map<string, MemoryEntry[]>();
  for (const m of inline) {
    const g = m.title ?? KIND_TITLES[m.kind];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(m);
  }
  const atOf = new Map<MemoryEntry, string>();
  if (inline.length) {
    const lines: string[] = ["# Memory"];
    let k = 0;
    for (const [title, list] of groups) {
      lines.push("", `## ${title}`, "");
      for (const m of list) {
        const body = m.content.trim().replace(/^[-*+]\s+/, "");
        const [first, ...rest] = body.split("\n");
        lines.push(`- ${first}`, ...rest.map((l) => (l.trim() ? `  ${l.trim()}` : "")));
        atOf.set(m, `MEMORY.md#${k++}`);
      }
    }
    text("MEMORY.md", lines.join("\n"));
  }
  const usedNotes = new Set<string>();
  for (const m of doc.memory) {
    if (atOf.has(m)) continue;
    const p = `memory/${slugUnique(m.date ?? m.title ?? m.id, usedNotes)}.md`;
    text(p, m.content.trim());
    atOf.set(m, p);
  }
  for (const m of doc.memory) {
    const inMemoryMd = atOf.get(m)!.startsWith("MEMORY.md");
    memMeta.push({
      id: m.id,
      kind: m.kind,
      scope: m.scope !== "agent" ? m.scope : undefined,
      at: atOf.get(m)!,
      // In MEMORY.md the section heading is the title, so only its absence is recorded.
      title: inMemoryMd ? undefined : m.title,
      untitled: inMemoryMd && !m.title ? true : undefined,
      date: m.date,
      tags: m.tags.length ? m.tags : undefined,
      dash: inMemoryMd && /^[-*+]\s+/.test(m.content.trim()) ? true : undefined,
      from: fromOut(m.source)
    });
  }

  // Skills
  const usedSkills = new Set<string>();
  const skillMeta: NonNullable<NomadManifest["skills"]> = {};
  for (const s of doc.skills) {
    const dir = slugUnique(s.name, usedSkills);
    const fm: Record<string, unknown> = { name: s.name, description: s.description || undefined, ...(s.allowedTools.length ? { "allowed-tools": s.allowedTools.join(", ") } : {}), ...(s.version ? { version: s.version } : {}), ...(s.author ? { author: s.author } : {}), ...s.frontmatter };
    if (s.invocation === "manual") fm["disable-model-invocation"] = true;
    files.set(`skills/${dir}/SKILL.md`, utf8(stringifyFrontmatter(fm, s.instructions)));
    for (const f of s.files) files.set(`skills/${dir}/${f.path}`, f.encoding === "base64" ? base64Decode(f.content) : utf8(f.content));
    const extra = nonEmpty({
      dependencies: s.dependencies.length ? s.dependencies : undefined,
      platforms: s.platforms.length ? s.platforms : undefined,
      config: Object.keys(s.config).length ? s.config : undefined,
      references: s.references.length ? s.references : undefined,
      installation: s.installation,
      source: fromOut(s.source),
      executable: s.files.filter((f) => f.executable).map((f) => f.path),
      noEol: s.instructions && !s.instructions.endsWith("\n") ? true : undefined,
      mediaTypes: Object.fromEntries(s.files.filter((f) => f.mediaType).map((f) => [f.path, f.mediaType]))
    });
    skillMeta[dir] = { name: s.name, ...(prune(extra) ?? {}) } as any;
  }

  // Routines
  const usedRoutines = new Set<string>();
  for (const w of doc.workflows) {
    const slug = slugUnique(w.name, usedRoutines);
    const singlePrompt = w.actions.length === 1 && w.actions[0].kind === "prompt";
    const { id, name, description, trigger, timezone, actions, requiredTools, dependencies, conditions, delivery, sourceEnabled, enabled: _e, source, ...ext } = w as any;
    const r: Record<string, unknown> = {
      name,
      ...(id !== slug ? { id } : {}),
      ...(description ? { description } : {}),
      schedule: scheduleString(trigger),
      ...(timezone ? { timezone } : {}),
      ...(singlePrompt ? { prompt: (actions[0] as any).text } : { steps: actions }),
      enabled: sourceEnabled,
      ...(delivery ? { delivery } : {}),
      ...(requiredTools.length ? { requires: requiredTools } : {}),
      ...(dependencies.length ? { dependencies } : {}),
      ...(conditions.length ? { conditions } : {}),
      ...(source ? { from: fromOut(source) } : {}),
      ...ext
    };
    text(`routines/${slug}.json`, JSON.stringify(r, null, 2));
  }

  // Tools
  const servers: Record<string, Record<string, unknown>> = {};
  const toolMeta: Record<string, Partial<Tool>> = {};
  for (const t of doc.tools) {
    const { name, kind, mcp, description, enabled, ...rest } = t;
    if (kind === "mcp" && mcp) {
      const env = (rec: typeof mcp.env) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, "value" in v ? v.value : `\${${v.secretRef}}`]));
      servers[name] = {
        ...(mcp.transport !== "stdio" ? { type: mcp.transport } : {}),
        ...(mcp.command ? { command: mcp.command } : {}),
        ...(mcp.args.length ? { args: mcp.args } : {}),
        ...(mcp.url ? { url: mcp.url } : {}),
        ...(Object.keys(mcp.env).length ? { env: env(mcp.env) } : {}),
        ...(Object.keys(mcp.headers).length ? { headers: env(mcp.headers) } : {}),
        ...(mcp.cwd ? { cwd: mcp.cwd } : {}),
        ...(description ? { description } : {}),
        ...(enabled === false ? { disabled: true } : {})
      };
      const extra = nonEmpty({ ...rest, permissions: rest.permissions?.length ? rest.permissions : undefined, platforms: rest.platforms?.length ? rest.platforms : undefined });
      if (extra) toolMeta[name] = extra;
    } else toolMeta[name] = t;
  }
  if (Object.keys(servers).length) text("tools.json", JSON.stringify({ mcpServers: servers }, null, 2));

  // Files
  for (const f of doc.files) files.set(`files/${f.path}`, f.encoding === "base64" ? base64Decode(f.content) : utf8(f.content));

  // Policy
  let policy: NomadManifest["policy"];
  if (doc.permissions.rules.length || doc.permissions.mode !== "ask" || doc.permissions.notes.length) {
    const by = (e: PermissionRule["effect"]) => doc.permissions.rules.filter((r) => r.effect === e).map(ruleString);
    const sources = Object.fromEntries(doc.permissions.rules.filter((r) => r.source).map((r) => [`${r.effect} ${ruleString(r)}`, r.source!]));
    policy = prune({ mode: doc.permissions.mode !== "ask" ? doc.permissions.mode : undefined, allow: by("allow"), ask: by("ask"), deny: by("deny"), sources, notes: doc.permissions.notes });
  }

  const integrity: Record<string, string> = {};
  for (const p of [...files.keys()].sort()) integrity[p] = sha256(files.get(p)!);

  const manifest: NomadManifest = {
    nomad: NOMAD_FORMAT,
    id: doc.id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    created: doc.createdAt,
    updated: doc.updatedAt,
    exported: options.exportedAt ?? new Date().toISOString(),
    generator: `nomad ${NOMAD_VERSION}`,
    from: { platform: doc.source.platform, ...(doc.source.platformVersion ? { version: doc.source.platformVersion } : {}), ...(doc.source.nativeId ? { nativeId: doc.source.nativeId } : {}) },
    identity: nonEmpty({ title: doc.identity.name !== doc.name ? doc.identity.name : undefined, description: doc.identity.description !== doc.description ? doc.identity.description : undefined, tone: doc.identity.tone, emoji: doc.identity.emoji, avatar: doc.identity.avatar, extensions: Object.keys(doc.identity.extensions ?? {}).length ? doc.identity.extensions : undefined }),
    models: doc.models.preferred ? [doc.models.preferred, ...doc.models.fallbacks] : doc.models.fallbacks.length ? doc.models.fallbacks : undefined,
    modelOptions: nonEmpty({ provider: doc.models.provider, reasoningEffort: doc.models.reasoningEffort, notes: doc.models.notes }),
    instructions: instrMeta && (instrMeta.length > 1 || instrMeta[0].kind !== "agent" || instrMeta[0].id !== "agents-md" || instrMeta[0].title || instrMeta[0].from) ? instrMeta : undefined,
    memory: memMeta.length ? memMeta : undefined,
    skills: Object.keys(skillMeta).length ? skillMeta : undefined,
    tools: Object.keys(toolMeta).length ? toolMeta : undefined,
    integrations: doc.integrations.length ? doc.integrations.map((i) => ({ ...i, source: fromOut(i.source) as any })) : undefined,
    policy,
    knowledge: doc.knowledge.length ? doc.knowledge : undefined,
    history: doc.history.length ? doc.history.slice(-20) : undefined,
    extensions: Object.keys(doc.extensions).length ? doc.extensions : undefined,
    secrets: options.secrets,
    files: integrity
  };
  files.set(NOMAD_MANIFEST, utf8(compactJson(stripUndefined(manifest)) + "\n"));
  return { files, manifest };
}

function stripUndefined<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** Pretty JSON that keeps short objects and arrays on one line, so manifests stay small and readable. */
export function compactJson(value: unknown, indent = ""): string {
  const flat = JSON.stringify(value);
  if (flat === undefined) return "null";
  if (flat.length + indent.length <= 110 || value === null || typeof value !== "object") return flat;
  const next = indent + "  ";
  if (Array.isArray(value)) return `[\n${value.map((v) => next + compactJson(v, next)).join(",\n")}\n${indent}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${compactJson(v, next)}`).join(",\n")}\n${indent}}`;
}

/** Never ship local absolute paths (they reveal usernames and folders). Keep the part inside the agent. */
function portablePath(p: unknown): unknown {
  if (typeof p !== "string" || !(/^([A-Za-z]:[\\/]|\/|~)/.test(p))) return p;
  const unix = p.replace(/\\/g, "/");
  const at = unix.lastIndexOf("/skills/");
  return at !== -1 ? unix.slice(at + 1) : unix.split("/").pop();
}

/** Remove empty arrays, empty objects and undefined values. */
function prune<T>(v: T): T | undefined {
  if (Array.isArray(v)) return (v.length ? v : undefined) as any;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (p !== undefined) out[k] = p;
    }
    return (Object.keys(out).length ? out : undefined) as any;
  }
  return v;
}

/** Provenance as "platform:path" when that is all it holds. */
function fromOut(src: unknown): unknown {
  if (!src || typeof src !== "object") return undefined;
  const o = { ...(src as Record<string, unknown>) };
  if ("path" in o) o.path = portablePath(o.path);
  const keys = Object.keys(o).filter((k) => o[k] !== undefined);
  if (keys.every((k) => k === "platform" || k === "path") && typeof o.platform === "string") return o.path ? `${o.platform}:${o.path}` : o.platform;
  return src;
}

function fromIn(v: unknown): any {
  if (typeof v !== "string") return v;
  const i = v.indexOf(":");
  return i === -1 ? { platform: v } : { platform: v.slice(0, i), path: v.slice(i + 1) };
}

/** The bytes a signature covers: the manifest without its signature, canonicalized. */
export function signedPayload(manifest: NomadManifest): string {
  const { signature: _s, ...rest } = manifest;
  return canonicalJson(rest);
}

export function isNomadPack(files: Map<string, Uint8Array>): boolean {
  return files.has(NOMAD_MANIFEST);
}

/* ------------------------------ reader ------------------------------ */

function encodeFile(data: Uint8Array, path: string): { encoding: "utf8" | "base64"; content: string } {
  if (/\.(md|markdown|txt|json|jsonl|ya?ml|toml|csv|tsv|xml|html|css|js|mjs|cjs|ts|py|sh|bash|zsh|rb|go|rs|lua|sql|ini|cfg|conf|mdc|svg)$/i.test(path)) {
    const t = fromUtf8(data);
    if (!t.includes("�")) return { encoding: "utf8", content: t };
  }
  return { encoding: "base64", content: base64Encode(data) };
}

interface ParsedBullet {
  section: string | null;
  content: string;
}

function parseMemoryFile(text: string): ParsedBullet[] {
  const out: ParsedBullet[] = [];
  let section: string | null = null;
  let current: ParsedBullet | null = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      section = h[1];
      current = null;
      continue;
    }
    if (/^#\s/.test(line)) continue;
    const b = /^[-*+]\s+(.*)$/.exec(line);
    if (b) {
      current = { section, content: b[1] };
      out.push(current);
    } else if (current && /^\s{2,}\S/.test(line)) current.content += "\n" + line.trim();
    else if (line.trim()) {
      current = { section, content: line.trim() };
      out.push(current);
    }
  }
  return out;
}

export interface NomadReadResult {
  doc: AgentDocument | null;
  manifest: NomadManifest | null;
  issues: ValidationIssue[];
  warnings: string[];
}

export function readNomadPack(files: Map<string, Uint8Array>, options: { verifyIntegrity?: boolean } = {}): NomadReadResult {
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  let manifest: NomadManifest;
  try {
    manifest = JSON.parse(fromUtf8(files.get(NOMAD_MANIFEST)!));
  } catch (e) {
    return { doc: null, manifest: null, issues: [{ path: NOMAD_MANIFEST, message: `Invalid JSON: ${(e as Error).message}` }], warnings };
  }
  if (typeof manifest.nomad !== "number" || manifest.nomad > NOMAD_FORMAT) {
    return { doc: null, manifest: null, issues: [{ path: `${NOMAD_MANIFEST}.nomad`, message: `This package uses format ${manifest.nomad}, newer than this version of Nomad reads (${NOMAD_FORMAT}). Update Nomad.` }], warnings };
  }
  if (!manifest.id || !manifest.name) return { doc: null, manifest: null, issues: [{ path: NOMAD_MANIFEST, message: "Missing id or name" }], warnings };
  const table = manifest.files ?? {};
  if (options.verifyIntegrity !== false) {
    for (const [p, h] of Object.entries(table)) {
      const d = files.get(p);
      if (!d) issues.push({ path: p, message: "File listed in nomad.json is missing" });
      else if (sha256(d) !== h) issues.push({ path: p, message: "Content does not match its recorded hash (the package was modified or corrupted)" });
    }
    for (const p of files.keys()) if (p !== NOMAD_MANIFEST && !(p in table)) warnings.push(`Ignored file not listed in nomad.json: ${p}`);
    if (issues.length) return { doc: null, manifest, issues, warnings };
  }
  const text = (p: string) => (files.has(p) ? fromUtf8(files.get(p)!) : undefined);

  // Instructions
  const agents = text("AGENTS.md")?.replace(/\n$/, "") ?? "";
  let instructions: Instruction[] = [];
  const meta = manifest.instructions;
  if (meta && meta.length > 1) {
    const lines = agents.split("\n");
    const starts: number[] = [];
    let from = 0;
    for (const m of meta) {
      const idx = lines.findIndex((l, i) => i >= from && l.trim() === `## ${m.heading ?? m.title}`);
      if (idx === -1) break;
      starts.push(idx);
      from = idx + 1;
    }
    if (starts.length === meta.length) {
      instructions = meta.map((m, k) => ({ id: m.id, kind: m.kind, title: m.title, content: lines.slice(starts[k] + 1, k + 1 < starts.length ? starts[k + 1] : lines.length).join("\n").trim(), ...(m.from ? { source: fromIn(m.from) } : {}) }));
    } else warnings.push("AGENTS.md sections were edited; it was read as one instruction.");
  } else if (meta && meta.length === 1 && agents.trim()) {
    instructions = [{ id: meta[0].id, kind: meta[0].kind, title: meta[0].title, content: agents.trim(), ...(meta[0].from ? { source: fromIn(meta[0].from) } : {}) }];
  }
  if (!instructions.length && agents.trim()) instructions = [{ id: "agents-md", kind: "agent", content: agents.trim() }];

  // Memory
  const bullets = text("MEMORY.md") ? parseMemoryFile(text("MEMORY.md")!) : [];
  const memory: MemoryEntry[] = [];
  const usedAt = new Set<string>();
  for (const m of manifest.memory ?? []) {
    let content: string | undefined;
    let title = m.title;
    if (m.at.startsWith("MEMORY.md#")) {
      const b = bullets[Number(m.at.slice(10))];
      if (b) {
        content = (m.dash ? "- " : "") + b.content;
        title = m.untitled ? undefined : b.section ?? undefined;
      }
    } else content = text(m.at)?.trim();
    if (content === undefined) {
      warnings.push(`Memory entry ${m.id} is missing from ${m.at.split("#")[0]}.`);
      continue;
    }
    usedAt.add(m.at);
    memory.push({ id: m.id, kind: m.kind, scope: m.scope ?? "agent", title, content, date: m.date, tags: m.tags ?? [], ...(m.from ? { source: fromIn(m.from) } : {}) });
  }
  // Entries added by hand after export
  bullets.forEach((b, k) => {
    if (!usedAt.has(`MEMORY.md#${k}`)) memory.push({ id: `memory-added-${k + 1}`, kind: "fact", scope: "agent", title: b.section ?? undefined, content: b.content, tags: [] });
  });
  for (const p of files.keys()) {
    const mm = /^memory\/([^/]+)\.md$/.exec(p);
    if (!mm || usedAt.has(p)) continue;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(mm[1]) ? mm[1] : undefined;
    memory.push({ id: `note-${mm[1]}`, kind: date ? "daily-log" : "note", scope: "agent", title: mm[1], content: text(p)!.trim(), date, tags: [] });
  }

  // Skills
  const dirs = new Map<string, Array<[string, Uint8Array]>>();
  for (const [p, d] of files) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(p);
    if (!m) continue;
    if (!dirs.has(m[1])) dirs.set(m[1], []);
    dirs.get(m[1])!.push([m[2], d]);
  }
  const skills: Skill[] = [];
  for (const [dir, list] of dirs) {
    const main = list.find(([p]) => p === "SKILL.md");
    if (!main) {
      warnings.push(`skills/${dir} has no SKILL.md and was skipped.`);
      continue;
    }
    const fm = parseFrontmatter(fromUtf8(main[1]));
    const { name, description, "allowed-tools": allowed, version, author, "disable-model-invocation": manual, ...rest } = fm.data as Record<string, any>;
    const extra: any = manifest.skills?.[dir] ?? {};
    const executable = new Set<string>(extra.executable ?? []);
    skills.push({
      name: typeof name === "string" ? name : extra.name ?? dir,
      description: typeof description === "string" ? description : "",
      instructions: extra.noEol ? fm.body.replace(/^\n+/, "").replace(/\n$/, "") : fm.body.replace(/^\n+/, ""),
      version: version !== undefined ? String(version) : undefined,
      author: typeof author === "string" ? author : undefined,
      dependencies: extra.dependencies ?? [],
      platforms: extra.platforms ?? [],
      allowedTools: typeof allowed === "string" ? allowed.split(/,\s*/).filter(Boolean) : Array.isArray(allowed) ? allowed : [],
      installation: extra.installation,
      config: extra.config ?? {},
      references: extra.references ?? [],
      files: list
        .filter(([p]) => p !== "SKILL.md")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([p, d]) => ({ path: p, ...encodeFile(d, p), executable: executable.has(p), ...(extra.mediaTypes?.[p] ? { mediaType: extra.mediaTypes[p] } : {}) })),
      frontmatter: rest,
      invocation: manual === true ? "manual" : "auto",
      ...(extra.source ? { source: fromIn(extra.source) } : {})
    });
  }

  // Routines
  const workflows: Workflow[] = [];
  for (const p of [...files.keys()].sort()) {
    if (!/^routines\/[^/]+\.json$/.test(p)) continue;
    let r: any;
    try {
      r = JSON.parse(text(p)!);
    } catch {
      warnings.push(`${p} is not valid JSON and was skipped.`);
      continue;
    }
    const trigger = typeof r.schedule === "string" ? parseSchedule(r.schedule) : null;
    if (!trigger || !r.name || (!r.prompt && !Array.isArray(r.steps))) {
      warnings.push(`${p} is not a complete routine and was skipped.`);
      continue;
    }
    const { id, name, description, schedule: _s, timezone, prompt, steps, enabled, delivery, requires, dependencies, conditions, from, ...ext } = r;
    workflows.push({
      id: id ?? p.slice(9, -5),
      name,
      description,
      trigger,
      timezone,
      actions: prompt ? [{ kind: "prompt", text: prompt }] : steps,
      requiredTools: requires ?? [],
      dependencies: dependencies ?? [],
      conditions: conditions ?? [],
      delivery,
      sourceEnabled: !!enabled,
      enabled: false,
      ...(from ? { source: fromIn(from) } : {}),
      ...ext
    } as Workflow);
  }

  // Tools
  const tools: Tool[] = [];
  const toolsJson = text("tools.json");
  if (toolsJson) {
    try {
      const servers = JSON.parse(toolsJson).mcpServers ?? {};
      for (const [name, s] of Object.entries(servers as Record<string, any>)) {
        const env = (rec: Record<string, string> | undefined) =>
          Object.fromEntries(Object.entries(rec ?? {}).map(([k, v]) => {
            const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(v));
            return [k, ref ? { secretRef: ref[1], redacted: true as const } : { value: String(v) }];
          }));
        const extra = manifest.tools?.[name] ?? {};
        tools.push({
          name,
          kind: "mcp",
          description: s.description,
          mcp: { transport: s.type ?? (s.url ? "http" : "stdio"), command: s.command, args: s.args ?? [], url: s.url, env: env(s.env), headers: env(s.headers), cwd: s.cwd },
          permissions: [],
          platforms: [],
          enabled: s.disabled !== true,
          ...extra
        } as Tool);
      }
    } catch (e) {
      issues.push({ path: "tools.json", message: `Invalid JSON: ${(e as Error).message}` });
    }
  }
  for (const [name, t] of Object.entries(manifest.tools ?? {})) if ((t as any).kind && (t as any).kind !== "mcp") tools.push({ ...(t as Tool), name });

  // Policy
  const rules: PermissionRule[] = [];
  const pol = manifest.policy ?? {};
  for (const effect of ["allow", "ask", "deny"] as const) {
    for (const s of pol[effect] ?? []) {
      const r = parseRuleString(s, effect);
      if (!r) continue;
      const src = pol.sources?.[`${effect} ${s}`];
      rules.push(src ? { ...r, source: src } : r);
    }
  }

  const docFiles: AgentDocument["files"] = [];
  for (const [p, d] of files) if (p.startsWith("files/")) docFiles.push({ path: p.slice(6), ...encodeFile(d, p), executable: false });

  const id = manifest.identity ?? {};
  const raw = {
    schemaVersion: UAF_SCHEMA_VERSION,
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    createdAt: manifest.created,
    updatedAt: manifest.updated,
    source: { platform: manifest.from?.platform ?? "nomad", platformVersion: manifest.from?.version, nativeId: manifest.from?.nativeId },
    identity: { name: id.title ?? manifest.name, description: id.description ?? manifest.description, persona: text("SOUL.md")?.trim() || undefined, tone: id.tone, emoji: id.emoji, avatar: id.avatar, extensions: id.extensions ?? {} },
    models: { preferred: manifest.models?.[0], fallbacks: manifest.models?.slice(1) ?? [], ...manifest.modelOptions },
    instructions,
    memory,
    skills,
    tools,
    integrations: (manifest.integrations ?? []).map((i) => (i.source ? { ...i, source: fromIn(i.source) } : i)),
    workflows,
    permissions: { mode: pol.mode ?? "ask", rules, notes: pol.notes ?? [] },
    knowledge: manifest.knowledge ?? [],
    files: docFiles,
    history: manifest.history ?? [],
    extensions: manifest.extensions ?? {}
  };
  const v = validateDocument(raw);
  if (!v.ok) return { doc: null, manifest, issues: [...issues, ...v.issues], warnings };
  return { doc: issues.length ? null : v.value, manifest, issues, warnings };
}
