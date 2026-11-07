import {
  AgentDocument,
  type MemoryEntry,
  type PackageManifest,
  PACKAGE_FORMAT,
  UAF_SCHEMA_VERSION,
  validateDocument,
  validateManifest,
  type ValidationIssue
} from "@nomad/schema";
import { base64Decode, base64Encode, fromUtf8, NOMAD_VERSION, sha256, utf8, componentCount } from "@nomad/core";

/**
 * File layout of an agent package. The same layout is used for .agentpack
 * archives and for unpacked "generic agent folders" on disk.
 */

const MEMORY_DIRS: Record<MemoryEntry["kind"], string> = {
  profile: "profile",
  preference: "preferences",
  fact: "facts",
  project: "project",
  instruction: "instructions",
  note: "notes",
  summary: "summaries",
  "daily-log": "daily",
  document: "documents"
};

export function safeSegment(s: string): string {
  const out = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 96);
  return out || "item";
}

function uniqueName(base: string, used: Set<string>): string {
  let n = base;
  let i = 2;
  while (used.has(n.toLowerCase())) n = `${base}-${i++}`;
  used.add(n.toLowerCase());
  return n;
}

const json = (v: unknown) => utf8(JSON.stringify(v, null, 2) + "\n");

export interface LayoutOptions {
  exportedAt?: string;
}

export function documentToFiles(doc: AgentDocument, options: LayoutOptions = {}): { manifest: PackageManifest; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const put = (path: string, data: Uint8Array) => files.set(path, data);

  // Identity
  const { persona, ...identityRest } = doc.identity;
  put("identity/identity.json", json(identityRest));
  if (persona) put("identity/persona.md", utf8(persona.endsWith("\n") ? persona : persona + "\n"));

  // Instructions
  const instrUsed = new Set<string>();
  const instructions = doc.instructions.map((ins, idx) => {
    const path = `instructions/${String(idx + 1).padStart(2, "0")}-${uniqueName(safeSegment(ins.id), instrUsed)}.md`;
    put(path, utf8(ins.content));
    return { id: ins.id, kind: ins.kind, title: ins.title, path, source: ins.source };
  });

  // Memory
  let memory: PackageManifest["memory"];
  if (doc.memory.length) {
    const used = new Set<string>();
    const index = doc.memory.map((m) => {
      const { content, ...meta } = m;
      const path = `memory/${MEMORY_DIRS[m.kind]}/${uniqueName(safeSegment(m.id), used)}.md`;
      put(path, utf8(content));
      return { ...meta, path };
    });
    put("memory/memory-index.json", json({ entries: index }));
    memory = { index: "memory/memory-index.json", count: index.length };
  }

  // Skills
  const skillUsed = new Set<string>();
  const skills = doc.skills.map((s) => {
    const dir = `skills/${uniqueName(safeSegment(s.name), skillUsed)}`;
    const { instructions: text, files: sfiles, ...meta } = s;
    const fileMeta = sfiles.map((f) => {
      put(`${dir}/files/${f.path}`, f.encoding === "base64" ? base64Decode(f.content) : utf8(f.content));
      return { path: f.path, encoding: f.encoding, mediaType: f.mediaType, executable: f.executable };
    });
    put(`${dir}/skill.json`, json({ ...meta, files: fileMeta }));
    put(`${dir}/instructions.md`, utf8(text));
    return { name: s.name, path: `${dir}/skill.json` };
  });

  // Tools
  const toolUsed = new Set<string>();
  const tools = doc.tools.map((t) => {
    const path = `tools/${uniqueName(safeSegment(t.name), toolUsed)}/tool.json`;
    put(path, json(t));
    return { name: t.name, path };
  });

  let integrations: string | undefined;
  if (doc.integrations.length) {
    integrations = "integrations/integrations.json";
    put(integrations, json({ integrations: doc.integrations }));
  }

  const wfUsed = new Set<string>();
  const workflows = doc.workflows.map((w) => {
    const path = `workflows/${uniqueName(safeSegment(w.id), wfUsed)}.json`;
    put(path, json(w));
    return { id: w.id, name: w.name, path };
  });

  let permissions: string | undefined;
  if (doc.permissions.rules.length || doc.permissions.mode !== "ask" || doc.permissions.notes.length) {
    permissions = "policies/permissions.json";
    put(permissions, json(doc.permissions));
  }

  let knowledge: string | undefined;
  if (doc.knowledge.length) {
    knowledge = "knowledge/knowledge-index.json";
    put(knowledge, json({ knowledge: doc.knowledge }));
  }

  const fileRefs = doc.files.map((f) => {
    const data = f.encoding === "base64" ? base64Decode(f.content) : utf8(f.content);
    put(`files/${f.path}`, data);
    return { path: `files/${f.path}`, sha256: sha256(data), size: data.length, mediaType: f.mediaType, executable: f.executable, encoding: f.encoding };
  });

  put("metadata/source.json", json(doc.source));
  let history: string | undefined;
  if (doc.history.length) {
    history = "metadata/migration-history.json";
    put(history, json({ history: doc.history }));
  }

  put("README.md", utf8(readme(doc)));

  const capabilities = (
    ["identity", "instructions", "memory", "skills", "tools", "integrations", "models", "permissions", "workflows", "knowledge", "project"] as const
  ).filter((c) => componentCount(doc, c) > 0);

  const integrity: Record<string, string> = {};
  for (const [p, d] of files) integrity[p] = sha256(d);

  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    schemaVersion: UAF_SCHEMA_VERSION,
    id: doc.id,
    name: doc.name,
    description: doc.description,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    packageVersion: doc.packageVersion,
    generator: { name: "nomad", version: NOMAD_VERSION },
    source: doc.source,
    capabilities: [...capabilities],
    models: doc.models,
    identity: "identity/identity.json",
    instructions,
    memory,
    skills,
    tools,
    integrations,
    workflows,
    permissions,
    knowledge,
    files: fileRefs,
    history,
    secrets: { included: false, redactedCount: 0, references: [] },
    integrity: { algorithm: "sha256", files: integrity },
    extensions: doc.extensions
  };
  files.set("manifest.json", json(manifest));
  return { manifest, files };
}

function readme(doc: AgentDocument): string {
  const lines = [
    `# ${doc.name}`,
    "",
    doc.description ?? doc.identity.description ?? "Portable agent package.",
    "",
    "This folder is a Nomad agent package (Universal Agent Format " + UAF_SCHEMA_VERSION + ").",
    "",
    "| Component | Items |",
    "| --- | --- |",
    `| Instructions | ${doc.instructions.length} |`,
    `| Memory entries | ${doc.memory.length} |`,
    `| Skills | ${doc.skills.length} |`,
    `| Tools | ${doc.tools.length} |`,
    `| Workflows | ${doc.workflows.length} (imported disabled) |`,
    `| Knowledge files | ${doc.knowledge.length + doc.files.length} |`,
    "",
    `Original platform: ${doc.source.platform}`,
    `Agent id: ${doc.id}`,
    "",
    "Secrets are never stored in this package unless they were explicitly included at export time.",
    "Import it with `nomad import <package>` or open it in the Nomad inspector.",
    ""
  ];
  return lines.join("\n");
}

export interface LayoutReadResult {
  doc: AgentDocument | null;
  manifest: PackageManifest | null;
  issues: ValidationIssue[];
  warnings: string[];
}

function readJson(files: Map<string, Uint8Array>, path: string, issues: ValidationIssue[]): any {
  const data = files.get(path);
  if (!data) {
    issues.push({ path, message: "Referenced file is missing" });
    return undefined;
  }
  try {
    return JSON.parse(fromUtf8(data));
  } catch (e) {
    issues.push({ path, message: `Invalid JSON: ${(e as Error).message}` });
    return undefined;
  }
}

function readText(files: Map<string, Uint8Array>, path: string, issues: ValidationIssue[]): string {
  const data = files.get(path);
  if (!data) {
    issues.push({ path, message: "Referenced file is missing" });
    return "";
  }
  return fromUtf8(data);
}

const TEXT_EXT = /\.(md|markdown|txt|json|jsonl|json5|ya?ml|toml|csv|tsv|xml|html|css|js|mjs|cjs|ts|py|sh|bash|zsh|rb|go|rs|lua|sql|ini|cfg|conf|mdc|rst|tex|svg)$/i;

function encodeFile(data: Uint8Array, path: string): { encoding: "utf8" | "base64"; content: string } {
  if (TEXT_EXT.test(path)) {
    const text = fromUtf8(data);
    if (!text.includes("�")) return { encoding: "utf8", content: text };
  }
  return { encoding: "base64", content: base64Encode(data) };
}

/** Rebuild a document from package files. Verifies integrity when the manifest carries hashes. */
export function filesToDocument(files: Map<string, Uint8Array>, options: { verifyIntegrity?: boolean } = {}): LayoutReadResult {
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  const manifestRaw = readJson(files, "manifest.json", issues);
  if (!manifestRaw) return { doc: null, manifest: null, issues, warnings };
  const mv = validateManifest(manifestRaw);
  if (!mv.ok) return { doc: null, manifest: null, issues: mv.issues.map((i) => ({ path: `manifest.${i.path}`, message: i.message })), warnings };
  const manifest = mv.value;

  if (options.verifyIntegrity !== false && manifest.integrity) {
    for (const [p, hash] of Object.entries(manifest.integrity.files)) {
      const d = files.get(p);
      if (!d) issues.push({ path: p, message: "File listed in the integrity table is missing" });
      else if (sha256(d) !== hash) issues.push({ path: p, message: "Content does not match its recorded hash (the package was modified or corrupted)" });
    }
    for (const p of files.keys()) {
      if (p !== "manifest.json" && !(p in manifest.integrity.files)) warnings.push(`Ignored file not listed in the manifest: ${p}`);
    }
  }

  const identityMeta = manifest.identity ? readJson(files, manifest.identity, issues) ?? {} : { name: manifest.name };
  const persona = files.has("identity/persona.md") ? readText(files, "identity/persona.md", issues) : undefined;

  const instructions = manifest.instructions.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    content: readText(files, r.path, issues),
    source: (r as any).source
  }));

  const memory: any[] = [];
  if (manifest.memory) {
    const idx = readJson(files, manifest.memory.index, issues);
    for (const e of idx?.entries ?? []) {
      const { path, ...meta } = e;
      if (typeof path !== "string") {
        issues.push({ path: manifest.memory.index, message: "Memory entry without a path" });
        continue;
      }
      memory.push({ ...meta, content: readText(files, path, issues) });
    }
  }

  const skills = manifest.skills.map((r) => {
    const meta = readJson(files, r.path, issues) ?? { name: r.name };
    const dir = r.path.replace(/\/skill\.json$/, "");
    const instr = files.has(`${dir}/instructions.md`) ? readText(files, `${dir}/instructions.md`, issues) : "";
    const sfiles = (meta.files ?? []).map((f: any) => {
      const data = files.get(`${dir}/files/${f.path}`);
      if (!data) {
        issues.push({ path: `${dir}/files/${f.path}`, message: "Skill file is missing" });
        return null;
      }
      const enc = encodeFile(data, f.path);
      return { path: f.path, mediaType: f.mediaType, executable: !!f.executable, ...enc };
    }).filter(Boolean);
    return { ...meta, instructions: instr, files: sfiles };
  });

  const tools = manifest.tools.map((r) => readJson(files, r.path, issues)).filter(Boolean);
  const integrations = manifest.integrations ? readJson(files, manifest.integrations, issues)?.integrations ?? [] : [];
  const workflows = manifest.workflows.map((r) => readJson(files, r.path, issues)).filter(Boolean);
  const permissions = manifest.permissions ? readJson(files, manifest.permissions, issues) : undefined;
  const knowledge = manifest.knowledge ? readJson(files, manifest.knowledge, issues)?.knowledge ?? [] : [];
  const docFiles = manifest.files.map((f) => {
    const data = files.get(f.path);
    if (!data) {
      issues.push({ path: f.path, message: "File is missing" });
      return null;
    }
    const rel = f.path.replace(/^files\//, "");
    return { path: rel, mediaType: (f as any).mediaType, executable: !!(f as any).executable, ...encodeFile(data, rel) };
  }).filter(Boolean);
  const source = files.has("metadata/source.json") ? readJson(files, "metadata/source.json", issues) : manifest.source;
  const history = manifest.history ? readJson(files, manifest.history, issues)?.history ?? [] : [];

  const raw = {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    packageVersion: manifest.packageVersion,
    source: source ?? manifest.source,
    identity: { ...identityMeta, persona },
    models: manifest.models,
    instructions,
    memory,
    skills,
    tools,
    integrations,
    workflows,
    permissions,
    knowledge,
    files: docFiles,
    history,
    extensions: manifest.extensions
  };
  const dv = validateDocument(raw);
  if (!dv.ok) return { doc: null, manifest, issues: [...issues, ...dv.issues], warnings };
  return { doc: issues.length ? null : dv.value, manifest, issues, warnings };
}
