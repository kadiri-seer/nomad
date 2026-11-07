import { join, basename } from "node:path";
import { promises as fsp } from "node:fs";
import { documentToFiles, filesToDocument } from "@nomad/archive";
import { createDocument, firstHeading, parseFrontmatter, type Adapter, type Note, type DesiredFile } from "@nomad/core";
import { readTextIfExists, walkFiles, pathExists } from "@nomad/core/node";
import { PACKAGE_FORMAT, type AgentDocument, type Instruction } from "@nomad/schema";
import { GENERIC_INFO } from "./catalog";
import { parseMemoryMarkdown, readSkillsTree } from "./util";

const INSTRUCTION_FILES: Array<{ file: string; kind: Instruction["kind"] }> = [
  { file: "SYSTEM.md", kind: "system" },
  { file: "AGENTS.md", kind: "agent" },
  { file: "AGENT.md", kind: "agent" },
  { file: "INSTRUCTIONS.md", kind: "agent" },
  { file: "PROMPT.md", kind: "system" },
  { file: "CLAUDE.md", kind: "agent" },
  { file: "GEMINI.md", kind: "agent" },
  { file: "TOOLS.md", kind: "conventions" },
  { file: "HEARTBEAT.md", kind: "heartbeat" }
];

const PERSONA_FILES = ["SOUL.md", "PERSONA.md", "persona.md"];

async function isPackageFolder(root: string): Promise<boolean> {
  const text = await readTextIfExists(join(root, "manifest.json"));
  if (!text) return false;
  try {
    return JSON.parse(text).format === PACKAGE_FORMAT;
  } catch {
    return false;
  }
}

async function readPackageFolder(root: string) {
  const files = new Map<string, Uint8Array>();
  for (const rel of await walkFiles(root, { maxFiles: 10000 })) {
    files.set(rel, new Uint8Array(await fsp.readFile(join(root, rel))));
  }
  return { files, read: filesToDocument(files) };
}

export const genericAdapter: Adapter = {
  info: GENERIC_INFO,

  async detect(root) {
    if (await isPackageFolder(root)) return { detected: true, confidence: 1, evidence: ["manifest.json (Nomad package)"] };
    const evidence: string[] = [];
    for (const f of [...INSTRUCTION_FILES.map((i) => i.file), ...PERSONA_FILES, "MEMORY.md"]) {
      if (await pathExists(join(root, f))) evidence.push(f);
    }
    return { detected: evidence.length > 0, confidence: evidence.length ? 0.3 : 0, evidence };
  },

  async discover(root) {
    if (await isPackageFolder(root)) {
      const m = JSON.parse((await readTextIfExists(join(root, "manifest.json")))!);
      return [{ nativeId: "package", name: m.name, description: m.description, location: root, kind: "package" }];
    }
    const d = await this.detect(root);
    if (!d.detected) return [];
    return [{ nativeId: "folder", name: basename(root), location: root, kind: "workspace" }];
  },

  async read(root, _nativeId) {
    const notes: Note[] = [];
    if (await isPackageFolder(root)) {
      const { files, read } = await readPackageFolder(root);
      if (!read.doc) {
        throw new Error("Package folder is invalid: " + read.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
      }
      for (const w of read.warnings) notes.push({ level: "warning", message: w });
      return { doc: read.doc, sourceFiles: [...files.keys()].map((f) => join(root, f)), notes };
    }

    const sourceFiles: string[] = [];
    const doc: AgentDocument = createDocument({ name: basename(root), platform: "generic" });
    doc.source.location = root;
    for (const { file, kind } of INSTRUCTION_FILES) {
      const text = await readTextIfExists(join(root, file));
      if (text === null) continue;
      sourceFiles.push(join(root, file));
      const fm = parseFrontmatter(text);
      doc.instructions.push({ id: file.replace(/\.md$/i, "").toLowerCase(), kind, title: file, content: fm.body.trim(), source: { platform: "generic", path: file } });
      const h = firstHeading(fm.body);
      if (h && doc.name === basename(root) && kind !== "conventions") {
        doc.name = h;
        doc.identity.name = h;
      }
    }
    for (const file of PERSONA_FILES) {
      const text = await readTextIfExists(join(root, file));
      if (text === null) continue;
      sourceFiles.push(join(root, file));
      doc.identity.persona = text.trim();
      break;
    }
    for (const [file, kind, scope] of [
      ["MEMORY.md", "fact", "agent"],
      ["USER.md", "profile", "user"]
    ] as const) {
      const text = await readTextIfExists(join(root, file));
      if (text === null) continue;
      sourceFiles.push(join(root, file));
      doc.memory.push(...parseMemoryMarkdown(text, { platform: "generic", path: file, defaultKind: kind, scope, idPrefix: file.replace(".md", "").toLowerCase() }));
    }
    for (const rel of await walkFiles(join(root, "memory"), { maxDepth: 2 })) {
      if (!rel.endsWith(".md")) continue;
      const text = (await readTextIfExists(join(root, "memory", rel)))!;
      sourceFiles.push(join(root, "memory", rel));
      const date = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(basename(rel))?.[1];
      doc.memory.push({
        id: `memory-${rel.replace(/\.md$/, "").replace(/[^A-Za-z0-9]+/g, "-")}`,
        kind: date ? "daily-log" : "note",
        scope: "agent",
        title: date ? `Log ${date}` : rel,
        content: text.trim(),
        date,
        tags: [],
        source: { platform: "generic", path: `memory/${rel}` }
      });
    }
    doc.skills.push(...(await readSkillsTree(join(root, "skills"), "generic", notes)));
    if (!doc.instructions.length && !doc.identity.persona && !doc.memory.length) {
      notes.push({ level: "warning", message: "No recognised agent files were found in this folder." });
    }
    return { doc, sourceFiles, notes };
  },

  async plan(doc, ctx) {
    // Deterministic output: the same agent always produces the same files.
    const { files } = documentToFiles(doc, { exportedAt: doc.updatedAt });
    const out: DesiredFile[] = [...files.entries()].map(([path, content]) => ({
      path,
      content,
      strategy: "replace",
      component: componentOf(path),
      description: path === "manifest.json" ? "Package manifest" : `Package file ${path}`,
      agentOwned: true
    }));
    return {
      nativeId: "package",
      files: out,
      notes: ctx.mode === "merge" ? [{ level: "info", message: "Agent folders hold one agent. Merge keeps files that differ and reports them." }] : [],
      manualSteps: [],
      conversions: [],
      unsupported: []
    };
  },

  async verify(doc, root) {
    const { read } = await readPackageFolder(root);
    return [
      { name: "Package is readable", ok: !!read.doc, detail: read.issues.map((i) => `${i.path}: ${i.message}`).join("; ") || undefined },
      { name: "Agent identity preserved", ok: read.doc?.id === doc.id }
    ];
  }
};

function componentOf(path: string): DesiredFile["component"] {
  const top = path.split("/")[0];
  switch (top) {
    case "instructions":
      return "instructions";
    case "memory":
      return "memory";
    case "skills":
      return "skills";
    case "tools":
      return "tools";
    case "integrations":
      return "integrations";
    case "workflows":
      return "workflows";
    case "policies":
      return "permissions";
    case "knowledge":
    case "files":
      return "knowledge";
    default:
      return "identity";
  }
}
