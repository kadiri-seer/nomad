import { join, basename } from "node:path";
import { promises as fsp } from "node:fs";
import type { AgentDocument, MemoryEntry, Skill, Tool, Instruction, PermissionRule, Capability, McpServer } from "@nomad/schema";
import {
  base64Encode,
  parseFrontmatter,
  stringifyFrontmatter,
  splitSections,
  bulletItems,
  sha256,
  slugify,
  type DesiredFile,
  type Note,
  type UnsupportedItem,
  type WriteContext
} from "@nomad/core";
import { applyKnownServerProfile } from "./known-servers";
import { elizaosPluginHint } from "./elizaos-known-plugins";
import type { ComponentCategory } from "@nomad/schema";
import { listDir, readTextIfExists, walkFiles, isDirectory } from "@nomad/core/node";
import { isSensitiveFile } from "@nomad/security";
import { extensionOf, EXECUTABLE_EXTENSIONS } from "@nomad/archive";

export { slugify };

/* ------------------------------------------------------------------ */
/* Skills (Agent Skills layout: <dir>/<name>/SKILL.md plus files)      */
/* ------------------------------------------------------------------ */

const TEXT_EXT = /\.(md|markdown|txt|json|jsonl|ya?ml|toml|csv|tsv|xml|html|css|js|mjs|cjs|ts|py|sh|bash|zsh|rb|go|rs|lua|sql|ini|cfg|conf|mdc|rst|tex|svg)$/i;

export async function readSkillDir(dir: string, platform: string, notes: Note[]): Promise<Skill | null> {
  const text = await readTextIfExists(join(dir, "SKILL.md"));
  if (text === null) return null;
  const fm = parseFrontmatter(text);
  const { name, description, version, author, license, metadata, ...rest } = fm.data as Record<string, any>;
  const allowed = rest["allowed-tools"] ?? rest.allowed_tools;
  delete rest["allowed-tools"];
  delete rest.allowed_tools;
  const files: Skill["files"] = [];
  for (const rel of await walkFiles(dir, { maxFiles: 300, skip: (r) => r === "SKILL.md" || r.split("/").some((p) => p === "node_modules" || p === ".git" || p === "__pycache__") })) {
    if (isSensitiveFile(rel)) {
      notes.push({ level: "warning", category: "skills", message: `Skipped credential file ${rel} in skill ${basename(dir)}` });
      continue;
    }
    const abs = join(dir, rel);
    const st = await fsp.stat(abs);
    if (st.size > 5 * 1024 * 1024) {
      notes.push({ level: "warning", category: "skills", message: `Skipped ${rel} in skill ${basename(dir)} (larger than 5 MB)` });
      continue;
    }
    const data = new Uint8Array(await fsp.readFile(abs));
    const executable = EXECUTABLE_EXTENSIONS.has(extensionOf(rel)) || (st.mode & 0o111) !== 0;
    const decoded = TEXT_EXT.test(rel) ? new TextDecoder().decode(data) : null;
    if (decoded !== null && !decoded.includes("�")) files.push({ path: rel, encoding: "utf8", content: decoded, executable });
    else files.push({ path: rel, encoding: "base64", content: base64Encode(data), executable });
  }
  return {
    name: typeof name === "string" && name ? name : basename(dir),
    description: typeof description === "string" ? description : "",
    instructions: fm.body.replace(/^\n+/, ""),
    version: version !== undefined ? String(version) : metadata?.version ? String(metadata.version) : undefined,
    author: typeof author === "string" ? author : undefined,
    dependencies: [],
    platforms: [],
    allowedTools: Array.isArray(allowed) ? allowed.map(String) : typeof allowed === "string" ? allowed.split(/[,\s]+/).filter(Boolean) : [],
    config: {},
    references: [],
    files,
    frontmatter: { ...rest, ...(license ? { license } : {}), ...(metadata ? { metadata } : {}) },
    invocation: rest["disable-model-invocation"] === true ? "manual" : "auto",
    source: { platform, path: join(dir, "SKILL.md") }
  };
}

/** Read every skill below a directory. Supports nested category folders. */
export async function readSkillsTree(dir: string, platform: string, notes: Note[], maxDepth = 3): Promise<Skill[]> {
  const out: Skill[] = [];
  async function rec(d: string, depth: number) {
    if (depth > maxDepth) return;
    for (const e of await listDir(d)) {
      if (!e.dir || e.name.startsWith(".")) continue;
      const sub = join(d, e.name);
      const skill = await readSkillDir(sub, platform, notes);
      if (skill) out.push(skill);
      else await rec(sub, depth + 1);
    }
  }
  if (await isDirectory(dir)) await rec(dir, 0);
  return out;
}

export function skillToFiles(skill: Skill, baseRel: string, extraFrontmatter: Record<string, unknown> = {}): DesiredFile[] {
  const dir = `${baseRel}/${safeName(skill.name)}`;
  const fm: Record<string, unknown> = {
    name: skill.name,
    description: skill.description || skill.name,
    ...(skill.allowedTools.length ? { "allowed-tools": skill.allowedTools.join(", ") } : {}),
    ...(skill.version ? { version: skill.version } : {}),
    ...skill.frontmatter,
    ...(skill.invocation === "manual" ? { "disable-model-invocation": true } : {}),
    ...extraFrontmatter
  };
  const files: DesiredFile[] = [
    {
      path: `${dir}/SKILL.md`,
      content: stringifyFrontmatter(fm, skill.instructions),
      strategy: "replace",
      component: "skills",
      description: `Skill "${skill.name}"`,
      agentOwned: true
    }
  ];
  for (const f of skill.files) {
    files.push({
      path: `${dir}/${f.path}`,
      content: f.encoding === "base64" ? Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0)) : f.content,
      strategy: "replace",
      component: "skills",
      description: `File ${f.path} of skill "${skill.name}"`,
      agentOwned: true,
      mode: f.executable ? 0o755 : 0o644
    });
  }
  return files;
}

export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "item";
}

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

function kindFromTitle(title: string | null, fallback: MemoryEntry["kind"]): MemoryEntry["kind"] {
  if (!title) return fallback;
  if (/prefer/i.test(title)) return "preference";
  if (/project/i.test(title)) return "project";
  if (/rule|instruction|always|never/i.test(title)) return "instruction";
  if (/summary|summaries/i.test(title)) return "summary";
  if (/profile|about (me|the user)|user/i.test(title)) return "profile";
  if (/note/i.test(title)) return "note";
  return fallback;
}

const MARKER_RE = /<!-- nomad:memory ([^>]*?) -->/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)=("([^"]*)"|\S+)/g)) out[m[1]] = m[3] ?? m[2];
  return out;
}

/**
 * Parse a Markdown memory file. Files written by Nomad carry markers and round
 * trip exactly. Other files are split by section and bullet: each bullet or
 * paragraph is its own entry, so unrelated memories are never combined.
 */
export function parseMemoryMarkdown(
  text: string,
  opts: { platform: string; path: string; defaultKind: MemoryEntry["kind"]; scope: MemoryEntry["scope"]; idPrefix: string; date?: string }
): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  if (text.includes("<!-- nomad:memory ")) {
    const parts = text.split(MARKER_RE);
    // split with capture: [pre, attrs1, body1, attrs2, body2...]
    for (let i = 1; i < parts.length; i += 2) {
      const a = parseAttrs(parts[i]);
      const body = parts[i + 1].replace(/\n## [^\n]*\n*$/, "").trim();
      entries.push({
        id: a.id ?? `${opts.idPrefix}-${entries.length + 1}`,
        kind: (a.kind as MemoryEntry["kind"]) ?? opts.defaultKind,
        scope: (a.scope as MemoryEntry["scope"]) ?? opts.scope,
        title: a.title || undefined,
        content: body,
        date: a.date || undefined,
        tags: a.tags ? a.tags.split(",") : [],
        source: { platform: opts.platform, path: opts.path }
      });
    }
    return entries;
  }
  let n = 0;
  for (const section of splitSections(text)) {
    const body = section.body.replace(/^#\s+.*$/m, "").trim();
    if (!body) continue;
    const kind = kindFromTitle(section.title, opts.defaultKind);
    const bullets = bulletItems(body);
    const nonBullet = body
      .split(/\r?\n/)
      .filter((l) => !/^\s*[-*+]\s+/.test(l) && !/^\s{2,}\S/.test(l))
      .join("\n")
      .trim();
    const items = bullets.length ? [...bullets, ...(nonBullet ? nonBullet.split(/\n\s*\n/) : [])] : body.split(/\n\s*\n/);
    for (const item of items) {
      const content = item.trim();
      if (!content) continue;
      n++;
      entries.push({
        id: `${opts.idPrefix}-${n}`,
        kind,
        scope: opts.scope,
        title: section.title ?? undefined,
        content,
        date: opts.date,
        tags: [],
        source: { platform: opts.platform, path: opts.path }
      });
    }
  }
  return entries;
}

const KIND_TITLES: Record<MemoryEntry["kind"], string> = {
  profile: "About the user",
  preference: "Preferences",
  fact: "Facts",
  project: "Project context",
  instruction: "Standing instructions",
  note: "Notes",
  summary: "Summaries",
  "daily-log": "Daily log",
  document: "Documents"
};

/** Render memory entries grouped by kind, with markers for an exact round trip. */
export function renderMemoryMarkdown(entries: MemoryEntry[], heading?: string): string {
  const lines: string[] = [];
  if (heading) lines.push(`# ${heading}`, "");
  const byKind = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const k = e.title ?? KIND_TITLES[e.kind];
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k)!.push(e);
  }
  for (const [title, list] of byKind) {
    lines.push(`## ${title}`, "");
    for (const e of list) {
      const attrs = [`id=${JSON.stringify(e.id)}`, `kind=${e.kind}`, `scope=${e.scope}`];
      if (e.title) attrs.push(`title=${JSON.stringify(e.title)}`);
      if (e.date) attrs.push(`date=${e.date}`);
      if (e.tags.length) attrs.push(`tags=${e.tags.join(",")}`);
      lines.push(`<!-- nomad:memory ${attrs.join(" ")} -->`);
      const body = e.content.trim();
      lines.push(/^[-*+] /.test(body) || body.includes("\n") ? body : `- ${body}`, "");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Bare body for plain stores (Hermes entries): strip a leading bullet marker. */
export function plainEntry(content: string): string {
  return content.trim().replace(/^[-*+]\s+/, "");
}

/* ------------------------------------------------------------------ */
/* Instructions rendering for single-file platforms                    */
/* ------------------------------------------------------------------ */

const SECTION_RE = /<!-- nomad:section ([^>]*?) -->/g;

/**
 * Render an agent into one Markdown body (used inside a managed block).
 * Sections carry markers so a later read can recover each instruction.
 */
export function renderAgentMarkdown(
  doc: AgentDocument,
  opts: { includePersona?: boolean; includeMemory?: boolean; memoryImports?: string[]; kinds?: Instruction["kind"][]; heading?: boolean } = {}
): string {
  const out: string[] = [];
  if (opts.heading !== false) out.push(`# ${doc.identity.name}`, "");
  if (doc.identity.description) out.push(doc.identity.description, "");
  if (opts.includePersona !== false && (doc.identity.persona || doc.identity.tone)) {
    out.push(`<!-- nomad:section kind=persona -->`, "## Persona", "", (doc.identity.persona ?? "").trim());
    if (doc.identity.tone) out.push("", `Tone: ${doc.identity.tone}`);
    out.push("");
  }
  for (const ins of doc.instructions) {
    if (opts.kinds && !opts.kinds.includes(ins.kind)) continue;
    if (!ins.content.trim()) continue;
    out.push(`<!-- nomad:section kind=instruction id=${JSON.stringify(ins.id)} type=${ins.kind}${ins.title ? ` title=${JSON.stringify(ins.title)}` : ""} -->`);
    out.push(`## ${ins.title ?? titleForKind(ins.kind)}`, "", demoteHeadings(ins.content.trim()), "");
  }
  if (opts.memoryImports?.length) {
    out.push(`<!-- nomad:section kind=memory-imports -->`, "## Memory", "", ...opts.memoryImports.map((p) => `@${p}`), "");
  } else if (opts.includeMemory && doc.memory.length) {
    out.push(`<!-- nomad:section kind=memory -->`, "## Memory", "", demoteHeadings(renderMemoryMarkdown(doc.memory)), "");
  }
  return out.join("\n").trim() + "\n";
}

function titleForKind(kind: Instruction["kind"]): string {
  switch (kind) {
    case "system":
      return "System instructions";
    case "agent":
      return "Instructions";
    case "custom":
      return "Custom instructions";
    case "user-context":
      return "About the user";
    case "conventions":
      return "Tool conventions";
    case "heartbeat":
      return "Heartbeat checklist";
    case "bootstrap":
      return "First run";
    case "command":
      return "Command";
  }
}

/** Push headings two levels down so embedded content cannot break the section structure. */
export function demoteHeadings(md: string): string {
  let inFence = false;
  return md
    .split("\n")
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
      const m = !inFence && /^(#{1,6})(\s.*)$/.exec(l);
      return m ? "#".repeat(Math.min(6, m[1].length + 2)) + m[2] : l;
    })
    .join("\n");
}

function promoteHeadings(md: string): string {
  let inFence = false;
  return md
    .split("\n")
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
      const m = !inFence && /^(#{3,6})(\s.*)$/.exec(l);
      return m ? "#".repeat(m[1].length - 2) + m[2] : l;
    })
    .join("\n");
}

export interface ParsedAgentMarkdown {
  persona?: string;
  tone?: string;
  instructions: Instruction[];
  memory: MemoryEntry[];
  memoryImports: string[];
}

/** Inverse of renderAgentMarkdown for content written by Nomad. */
export function parseAgentMarkdown(text: string, platform: string, path: string): ParsedAgentMarkdown {
  const result: ParsedAgentMarkdown = { instructions: [], memory: [], memoryImports: [] };
  const parts = text.split(SECTION_RE);
  for (let i = 1; i < parts.length; i += 2) {
    const a = parseAttrs(parts[i]);
    const body = parts[i + 1].replace(/^\s*##[^\n]*\n/, "").trim();
    if (a.kind === "persona") {
      const m = /\n\nTone: (.*)$/.exec(body);
      result.persona = m ? body.slice(0, m.index).trim() : body;
      if (m) result.tone = m[1].trim();
    } else if (a.kind === "instruction") {
      result.instructions.push({
        id: a.id ?? `section-${i}`,
        kind: (a.type as Instruction["kind"]) ?? "agent",
        title: a.title,
        content: promoteHeadings(body),
        source: { platform, path }
      });
    } else if (a.kind === "memory") {
      result.memory.push(...parseMemoryMarkdown(promoteHeadings(body), { platform, path, defaultKind: "fact", scope: "agent", idPrefix: "memory" }));
    } else if (a.kind === "memory-imports") {
      result.memoryImports.push(...body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("@")).map((l) => l.slice(1)));
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* MCP servers                                                         */
/* ------------------------------------------------------------------ */

/** Reference syntaxes: ${VAR}, ${env:VAR} (Cursor), ${VAR:-} and ${VAR:-default}. */
const ENV_REF = /^\$\{(env:)?([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}$/;

interface EnvParse {
  rec: McpServer["env"];
  /** Entries that may be unset on the source (empty default, or a platform that drops unset refs). */
  optional: string[];
  /** Non-empty defaults that are not carried. */
  defaults: Array<[string, string]>;
}

function envRecord(raw: unknown, refsOptional = false): EnvParse {
  const out: EnvParse = { rec: {}, optional: [], defaults: [] };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") {
        const ref = ENV_REF.exec(v);
        if (!ref) {
          out.rec[k] = { value: v };
          continue;
        }
        out.rec[k] = { secretRef: ref[2], redacted: true };
        if (ref[3] !== undefined && ref[4]) out.defaults.push([k, ref[4]]);
        else if (ref[3] !== undefined || refsOptional) out.optional.push(k);
      } else if (v !== null && v !== undefined) out.rec[k] = { value: String(v) };
    }
  }
  return out;
}

export interface McpReadOptions {
  notes?: Note[];
  /** The source drops stdio env entries whose reference is unset (Hermes), so every reference is optional. */
  refsOptional?: boolean;
  /** Provenance note, for example "plugin priors". */
  note?: string;
  /** Extra provenance fields (for example the plugin a server came from). */
  extra?: Record<string, unknown>;
}

/** Claude style `mcpServers` object (Claude Code, Cursor, Gemini CLI, Roo, Windsurf, Hermes, ElizaOS). */
export function toolsFromMcpServers(raw: unknown, platform: string, path: string, opts: McpReadOptions = {}): Tool[] {
  if (!raw || typeof raw !== "object") return [];
  const tools: Tool[] = [];
  for (const [name, cfg] of Object.entries(raw as Record<string, any>)) {
    if (!cfg || typeof cfg !== "object") continue;
    const url = cfg.url ?? cfg.httpUrl ?? cfg.serverUrl;
    const transport = cfg.type === "sse" || cfg.transport === "sse" ? "sse" : url ? "http" : "stdio";
    const env = envRecord(cfg.env, opts.refsOptional && transport === "stdio");
    const headers = envRecord(cfg.headers ?? cfg.http_headers);
    for (const [k, d] of env.defaults) opts.notes?.push({ level: "info", category: "tools", message: `"${name}": ${k} has a default (${d.length > 40 ? `${d.length} characters` : d}) that is not carried. Set ${k} on the destination if you rely on it.` });
    const mcp: McpServer = {
      transport,
      command: typeof cfg.command === "string" ? cfg.command : undefined,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      url: typeof url === "string" ? url : undefined,
      env: env.rec,
      headers: headers.rec,
      cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined
    };
    if (env.optional.length) (mcp as Record<string, unknown>).optionalEnv = env.optional;
    tools.push({
      name,
      description: typeof cfg.description === "string" ? cfg.description : undefined,
      kind: "mcp",
      mcp,
      permissions: [],
      platforms: [],
      enabled: cfg.disabled !== true && cfg.enabled !== false,
      source: { platform, path, ...(opts.note ? { note: opts.note } : {}), ...(opts.extra ?? {}) }
    });
  }
  return tools;
}

/** A server or skill that came from an installed plugin, rather than from the platform's own config (host is the platform id). */
export function pluginOf(item: { source?: Record<string, unknown> | undefined }, host: string): string | null {
  const src = item.source;
  return src?.pluginHost === host && typeof src.plugin === "string" ? src.plugin : null;
}

/** The setup step for an integration; plugins read from the source get their own wording. */
export function integrationStep(i: { name: string; kind: string; notes?: string }, platformName: string, otherwise: string): string {
  if (i.kind === "elizaos-plugin") {
    return `${i.name} was an ElizaOS plugin. ${elizaosPluginHint(i.name)}`;
  }
  if (i.kind === "claude-code-plugin" || i.kind === "hermes-plugin") {
    return `${i.name} was an installed ${i.kind === "hermes-plugin" ? "Hermes" : "Claude Code"} plugin (installed plugin read, not installed). Its servers and skills are written to ${platformName} as ordinary entries where ${platformName} has a place for them.`;
  }
  return otherwise;
}

export interface McpRefs {
  /** Env entries kept as references (names of the env keys). */
  env: string[];
  headers: Array<[string, string]>;
  /** Env entries that may be unset. */
  optional: string[];
}

export interface McpWriteResult {
  servers: Record<string, Record<string, unknown>>;
  manualSteps: string[];
  unsupported: UnsupportedItem[];
  notes: Note[];
  /** References per server, for writers that map them natively (Codex env_vars). */
  refs: Record<string, McpRefs>;
}

export interface McpWriteOptions {
  platformName: string;
  /** Legacy switch: true means "dollar", false means "none". */
  envExpansion?: boolean;
  /** How references are written: ${NAME}, ${env:NAME} (Cursor), or not at all (manual steps). */
  envRefStyle?: "dollar" | "env-prefix" | "none";
  urlKey?: string;
  typeField?: boolean;
  /** How an optional reference is written on this destination; null leaves it to a manual step. */
  optionalRef?: (tool: Tool, name: string) => string | null;
}

/**
 * Convert tools into a Claude style mcpServers object. Disabled servers are
 * not written, known servers get their profile applied (known-servers.ts),
 * and references follow the destination's own syntax.
 */
export function mcpServersFromTools(tools: Tool[], opts: McpWriteOptions): McpWriteResult {
  const style = opts.envRefStyle ?? (opts.envExpansion ? "dollar" : "none");
  const asRef = (name: string) => (style === "env-prefix" ? `\${env:${name}}` : `\${${name}}`);
  const out: McpWriteResult = { servers: {}, manualSteps: [], unsupported: [], notes: [], refs: {} };
  const seenNotes = new Set<string>();
  for (const original of tools) {
    if (original.kind !== "mcp" || !original.mcp) continue;
    if (original.enabled === false) {
      out.unsupported.push({ category: "tools", item: original.name, reason: "Disabled on the source, so it is not added.", alternative: "Add it yourself if you want it active here." });
      continue;
    }
    const profile = applyKnownServerProfile(original, opts.platformName);
    const t = profile.tool;
    out.manualSteps.push(...profile.manualSteps);
    out.unsupported.push(...profile.unsupported);
    for (const n of profile.notes) if (!seenNotes.has(n.message)) (seenNotes.add(n.message), out.notes.push(n));
    const trust = ((t as Record<string, unknown>).extensions as Record<string, { trust?: unknown }> | undefined)?.["x-hermes"]?.trust;
    if (trust === "untrusted") {
      out.unsupported.push({ category: "permissions", item: `${t.name}: Hermes asked before every call that is not read-only (trust: untrusted)`, reason: "Destination approvals are not copied.", alternative: `Set ${opts.platformName} to ask before using "${t.name}" tools, before using real funds.` });
    }
    const mcp = t.mcp!;
    const s: Record<string, unknown> = {};
    if (mcp.transport === "stdio") {
      s.command = mcp.command;
      if (mcp.args.length) s.args = mcp.args;
      if (mcp.cwd) s.cwd = mcp.cwd;
    } else {
      s[opts.urlKey ?? "url"] = mcp.url;
      if (opts.typeField) s.type = mcp.transport;
    }
    const optionalNames = new Set(((mcp as Record<string, unknown>).optionalEnv as string[] | undefined) ?? []);
    const refs: McpRefs = { env: [], headers: [], optional: [] };
    const env: Record<string, string> = {};
    const missing: string[] = [];
    const optionalMissing: string[] = [];
    for (const [k, v] of Object.entries(mcp.env)) {
      if ("value" in v) {
        env[k] = v.value;
        continue;
      }
      refs.env.push(k);
      if (optionalNames.has(k)) {
        refs.optional.push(k);
        const written = style === "none" ? null : (opts.optionalRef?.(t, k) ?? null);
        if (written !== null) env[k] = written;
        else optionalMissing.push(k);
        continue;
      }
      if (style !== "none") env[k] = asRef(v.secretRef);
      missing.push(style === "none" ? k : v.secretRef);
    }
    if (Object.keys(env).length) s.env = env;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(mcp.headers)) {
      if ("value" in v) headers[k] = v.value;
      else {
        refs.headers.push([k, v.secretRef]);
        if (style !== "none") {
          headers[k] = asRef(v.secretRef);
          missing.push(v.secretRef);
        } else missing.push(`${k} header`);
      }
    }
    if (Object.keys(headers).length) s.headers = headers;
    out.servers[t.name] = s;
    out.refs[t.name] = refs;
    if (missing.length) {
      out.manualSteps.push(
        style !== "none"
          ? `Set ${missing.join(", ")} in your environment so the "${t.name}" MCP server can authenticate in ${opts.platformName}.`
          : `Add ${missing.join(", ")} for the "${t.name}" MCP server in ${opts.platformName}. Nomad does not write secret values.`
      );
    }
    if (optionalMissing.length) {
      out.manualSteps.push(`If you use them, set ${optionalMissing.join(", ")} for the "${t.name}" MCP server in ${opts.platformName}. They were optional on the source and ${opts.platformName} may not accept an unset reference, so Nomad left them out.`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

export type ModelFamily = "anthropic" | "openai" | "google" | "xai" | "meta" | "mistral" | "deepseek" | "qwen" | "other";

export function modelFamily(model: string | undefined): ModelFamily | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (/(^|\/)(claude|anthropic)|^(opus|sonnet|haiku)$/.test(m) || m.startsWith("anthropic/")) return "anthropic";
  if (/(^|\/)(gpt|o\d|codex|chatgpt)|^openai\//.test(m)) return "openai";
  if (/(^|\/)gemini|^google\//.test(m)) return "google";
  if (/(^|\/)grok|^x-?ai\//.test(m)) return "xai";
  if (/llama|^meta/.test(m)) return "meta";
  if (/mistral|codestral/.test(m)) return "mistral";
  if (/deepseek/.test(m)) return "deepseek";
  if (/qwen/.test(m)) return "qwen";
  return "other";
}

/** "anthropic/claude-sonnet-4-5" -> "claude-sonnet-4-5" */
export function bareModel(model: string): string {
  return model.includes("/") ? model.split("/").slice(1).join("/") : model;
}

export function qualifiedModel(model: string, provider?: string): string {
  if (model.includes("/")) return model;
  const fam = provider ?? modelFamily(model);
  return fam && fam !== "other" ? `${fam}/${model}` : model;
}

/* ------------------------------------------------------------------ */
/* Permissions helpers                                                 */
/* ------------------------------------------------------------------ */

export function rule(capability: Capability, effect: PermissionRule["effect"], pattern?: string, source?: string): PermissionRule {
  return { capability, effect, ...(pattern ? { pattern } : {}), ...(source ? { source } : {}) };
}

export function rulesFor(rules: PermissionRule[], capability: Capability) {
  return rules.filter((r) => r.capability === capability);
}

/** Unpatterned rule effect for a capability, the strictest one wins. */
export function blanketEffect(rules: PermissionRule[], capability: Capability): PermissionRule["effect"] | null {
  const r = rules.filter((x) => x.capability === capability && !x.pattern);
  if (r.some((x) => x.effect === "deny")) return "deny";
  if (r.some((x) => x.effect === "ask")) return "ask";
  if (r.some((x) => x.effect === "allow")) return "allow";
  return null;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function nomadBlockKey(doc: AgentDocument): string {
  return `agent=${doc.id}`;
}

export function filesHash(files: DesiredFile[]): string {
  return sha256(files.map((f) => f.path + ":" + (typeof f.content === "string" ? sha256(f.content) : sha256(f.content))).join("\n"));
}

export function wants(ctx: WriteContext, c: ComponentCategory) {
  return ctx.components.includes(c);
}

export function workflowPrompt(actions: AgentDocument["workflows"][number]["actions"]): string {
  return actions
    .map((a) => (a.kind === "prompt" ? a.text : a.kind === "skill" ? `Use the ${a.name} skill.` : `Run ${a.path}.`))
    .join("\n\n");
}

export function describeTrigger(t: AgentDocument["workflows"][number]["trigger"], tz?: string): string {
  switch (t.kind) {
    case "cron":
      return `cron "${t.expr}"${tz ? ` (${tz})` : ""}`;
    case "interval":
      return `every ${Math.round(t.everyMs / 60000)} minutes`;
    case "once":
      return `once at ${t.at}`;
    case "event":
      return `on event ${t.event}`;
    case "manual":
      return "manually";
  }
}

/** Steps for routines a destination cannot schedule. */
export function workflowManualSteps(doc: AgentDocument, platformName: string): string[] {
  return doc.workflows.map(
    (w) => `Recreate routine "${w.name}" (${describeTrigger(w.trigger, w.timezone)}) outside ${platformName}. Its prompt is in the migration report.`
  );
}

/** Memory file that may contain Nomad blocks and hand-written content. */
export function parseMixedMemory(
  text: string,
  opts: { platform: string; path: string; defaultKind: MemoryEntry["kind"]; scope: MemoryEntry["scope"]; idPrefix: string; date?: string }
): MemoryEntry[] {
  const blocks = [...text.matchAll(/<!-- nomad:begin [^>]* -->([\s\S]*?)<!-- nomad:end [^>]* -->/g)].map((m) => m[1]);
  const outside = text.replace(/<!-- nomad:begin [^>]* -->[\s\S]*?<!-- nomad:end [^>]* -->/g, "").trim();
  const entries: MemoryEntry[] = [];
  for (const b of blocks) {
    if (b.includes("<!-- nomad:section ")) {
      const parsed = parseAgentMarkdown(b, opts.platform, opts.path);
      entries.push(...parsed.memory);
    } else entries.push(...parseMemoryMarkdown(b, opts));
  }
  if (outside) entries.push(...parseMemoryMarkdown(outside, opts).filter((e) => !/^#\s/.test(e.content)));
  return entries;
}
