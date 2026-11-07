import { promises as fsp } from "node:fs";
import { dirname, join, relative } from "node:path";
import JSON5 from "json5";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parseDocument as parseYamlDocument, isMap, type Document } from "yaml";
import { createTwoFilesPatch } from "diff";
import {
  deepMerge,
  extractBlock,
  fromUtf8,
  isPlainObject,
  mergeEntries,
  sha256,
  upsertBlock,
  utf8,
  type ConflictMode,
  type DesiredFile,
  type MergeConflict
} from "@nomad/core";
import { assertNoSymlinks, atomicWrite, displayPath, safeJoin, UnsafePathError } from "@nomad/core/node";
import type { NomadStore } from "@nomad/storage";

export type FileAction = "create" | "update" | "unchanged" | "keep-existing";

export interface FileOperation {
  root: string;
  rel: string;
  abs: string;
  display: string;
  action: FileAction;
  strategy: DesiredFile["strategy"];
  component: DesiredFile["component"];
  description: string;
  before: Uint8Array | null;
  after: Uint8Array | null;
  beforeHash: string | null;
  afterHash: string | null;
  mode?: number;
  /** Why an existing file was kept, or what was merged. */
  conflicts: string[];
  /** The file changed since Nomad last wrote it. */
  userModified: boolean;
  /** Replacing content that Nomad did not write. Needs the replace approval. */
  replacesForeign: boolean;
  diff?: string;
  error?: string;
  /** Key used to record what Nomad wrote (file path, or path#block). */
  recordKey: string;
  recordHash: string | null;
}

async function readExisting(abs: string): Promise<Uint8Array | null> {
  try {
    const st = await fsp.lstat(abs);
    if (!st.isFile()) throw new UnsafePathError(`${abs} exists and is not a regular file`);
    return new Uint8Array(await fsp.readFile(abs));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

function asText(c: string | Uint8Array): string {
  return typeof c === "string" ? c : fromUtf8(c);
}

function asBytes(c: string | Uint8Array): Uint8Array {
  return typeof c === "string" ? utf8(c) : c;
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function describeConflicts(conflicts: MergeConflict[]): string[] {
  return conflicts.slice(0, 20).map((c) => (c.resolution === "kept-existing" ? `Kept existing value at ${c.path}` : `Replaced value at ${c.path}`));
}

function applyToYamlDocument(doc: Document, path: (string | number)[], value: unknown, existing: unknown) {
  if (isPlainObject(value) && isPlainObject(existing)) {
    for (const [k, v] of Object.entries(value)) {
      if (JSON.stringify((existing as any)[k]) !== JSON.stringify(v)) applyToYamlDocument(doc, [...path, k], v, (existing as any)[k]);
    }
    return;
  }
  doc.setIn(path, value);
}

function structuredMerge(
  strategy: DesiredFile["strategy"],
  existingText: string,
  incomingText: string,
  mode: ConflictMode,
  arrayKeys: Record<string, string> | undefined
): { text: string; conflicts: MergeConflict[] } {
  const mergeMode = mode === "replace" ? "replace" : "merge";
  switch (strategy) {
    case "merge-json":
    case "merge-json5": {
      const existing = existingText.trim() ? (strategy === "merge-json5" ? JSON5.parse(existingText) : JSON.parse(existingText)) : {};
      const incoming = JSON.parse(incomingText);
      const r = deepMerge(existing, incoming, { mode: mergeMode, arrayKeys });
      return { text: JSON.stringify(r.value, null, 2) + "\n", conflicts: r.conflicts };
    }
    case "merge-toml": {
      const existing = existingText.trim() ? parseToml(existingText) : {};
      const incoming = parseToml(incomingText);
      const r = deepMerge(existing, incoming, { mode: mergeMode, arrayKeys });
      return { text: stringifyToml(r.value as Record<string, unknown>) + "\n", conflicts: r.conflicts };
    }
    case "merge-yaml": {
      const doc = parseYamlDocument(existingText || "{}\n");
      if (doc.errors.length) throw new Error(doc.errors[0].message);
      const existing = doc.toJS() ?? {};
      const incoming = parseYamlDocument(incomingText).toJS() ?? {};
      const r = deepMerge(existing, incoming, { mode: mergeMode, arrayKeys });
      if (!existingText.trim() || !isMap(doc.contents)) return { text: parseYamlDocument(JSON.stringify(r.value)).toString(), conflicts: r.conflicts };
      applyToYamlDocument(doc, [], r.value, existing);
      return { text: doc.toString(), conflicts: r.conflicts };
    }
    default:
      throw new Error(`Not a structured strategy: ${strategy}`);
  }
}

export interface ComputeContext {
  root: string;
  mode: ConflictMode;
  store: NomadStore;
  agentId: string;
}

/**
 * Work out the final content of every file the adapter wants, without writing.
 * This is where conflict policy lives:
 *  - content Nomad did not write is never replaced in merge or copy mode;
 *  - in replace mode it is, but the plan asks for explicit approval;
 *  - content Nomad wrote that the user changed afterwards needs its own approval.
 */
export async function computeOperations(files: DesiredFile[], ctx: ComputeContext): Promise<FileOperation[]> {
  const ops: FileOperation[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const root = f.root ?? ctx.root;
    const op: FileOperation = {
      root,
      rel: f.path,
      abs: "",
      display: "",
      action: "unchanged",
      strategy: f.strategy,
      component: f.component,
      description: f.description,
      before: null,
      after: null,
      beforeHash: null,
      afterHash: null,
      mode: f.mode,
      conflicts: [],
      userModified: false,
      replacesForeign: false,
      recordKey: "",
      recordHash: null
    };
    try {
      op.abs = safeJoin(root, f.path);
      op.display = displayPath(op.abs);
      if (seen.has(op.abs)) throw new Error(`The adapter planned ${f.path} twice`);
      seen.add(op.abs);
      assertNoSymlinks(root, op.abs);
      const before = await readExisting(op.abs);
      op.before = before;
      op.beforeHash = before ? sha256(before) : null;
      op.recordKey = f.strategy === "managed-block" ? `${op.abs}#${f.blockKey}` : op.abs;
      const last = ctx.store.lastWrite(op.recordKey);
      const incoming = asBytes(f.content);

      if (!before) {
        op.action = "create";
        op.after = f.strategy === "managed-block" ? utf8(upsertBlock("", f.blockKey!, asText(f.content))) : incoming;
      } else {
        const text = fromUtf8(before);
        switch (f.strategy) {
          case "replace":
          case "create-only": {
            if (equalBytes(before, incoming)) break;
            const ours = !!last && last.sha256 === op.beforeHash;
            op.userModified = !!last && last.sha256 !== op.beforeHash;
            if (f.strategy === "replace" && (ctx.mode === "replace" || ours)) {
              op.action = "update";
              op.after = incoming;
              if (!last) op.replacesForeign = true;
            } else {
              op.action = "keep-existing";
              op.conflicts.push(
                op.userModified
                  ? "The file was edited after Nomad wrote it. It was kept."
                  : "A different file already exists. It was kept; choose replace to overwrite it."
              );
            }
            break;
          }
          case "managed-block": {
            const currentBlock = extractBlock(text, f.blockKey!);
            const blockHash = currentBlock === null ? null : sha256(currentBlock);
            op.userModified = !!last && currentBlock !== null && last.sha256 !== blockHash;
            if (op.userModified && ctx.mode !== "replace") {
              op.action = "keep-existing";
              op.conflicts.push("The Nomad section was edited after Nomad wrote it. It was kept; choose replace to overwrite it.");
              break;
            }
            if (currentBlock !== null && !last && ctx.mode !== "replace") {
              op.action = "keep-existing";
              op.conflicts.push("A Nomad section for this agent exists but was not written from this machine. It was kept; choose replace to overwrite it.");
              break;
            }
            const next = upsertBlock(text, f.blockKey!, asText(f.content));
            if (next !== text) {
              op.action = "update";
              op.after = utf8(next);
              if (currentBlock !== null && !last) op.replacesForeign = true;
            }
            break;
          }
          case "append-entries": {
            if (ctx.mode === "replace") {
              const r = asText(f.content);
              if (r !== text) {
                op.action = "update";
                op.after = utf8(r);
                op.replacesForeign = true;
                op.conflicts.push("Existing entries are replaced.");
              }
            } else {
              const r = mergeEntries(text, asText(f.content), f.entryDelimiter ?? "\n");
              if (r.added) {
                op.action = "update";
                op.after = utf8(r.value);
              }
              if (r.duplicates) op.conflicts.push(`${r.duplicates} duplicate entr${r.duplicates === 1 ? "y" : "ies"} skipped`);
            }
            break;
          }
          default: {
            const r = structuredMerge(f.strategy, text, asText(f.content), ctx.mode, f.arrayKeys);
            op.conflicts.push(...describeConflicts(r.conflicts));
            if (r.conflicts.some((c) => c.resolution === "used-incoming")) op.replacesForeign = true;
            if (r.text !== text) {
              op.action = "update";
              op.after = utf8(r.text);
            }
          }
        }
      }
      if (op.after) {
        op.afterHash = sha256(op.after);
        op.recordHash = f.strategy === "managed-block" ? sha256(extractBlock(fromUtf8(op.after), f.blockKey!) ?? "") : op.afterHash;
        op.diff = makeDiff(op);
      }
    } catch (e) {
      op.error = (e as Error).message;
    }
    ops.push(op);
  }
  return ops;
}

function looksBinary(b: Uint8Array) {
  const n = Math.min(b.length, 4096);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

function makeDiff(op: FileOperation): string | undefined {
  if (!op.after) return undefined;
  if ((op.before && looksBinary(op.before)) || looksBinary(op.after)) return "(binary file)";
  const a = op.before ? fromUtf8(op.before) : "";
  const b = fromUtf8(op.after);
  if (a.length + b.length > 400_000) return "(file too large to show a diff)";
  const patch = createTwoFilesPatch(op.before ? op.display : "/dev/null", op.display, a, b, "", "", { context: 3 });
  const lines = patch.split("\n");
  return lines.length > 400 ? lines.slice(0, 400).join("\n") + `\n... ${lines.length - 400} more lines` : patch;
}

export interface AppliedResult {
  written: FileOperation[];
}

/**
 * Apply operations as one transaction. Every write is atomic; on any failure the
 * files already written are restored from memory (their previous bytes) or
 * removed, and directories created by this run are cleaned up.
 */
export async function applyOperations(ops: FileOperation[]): Promise<AppliedResult> {
  const pending = ops.filter((o) => o.action === "create" || o.action === "update");
  const done: FileOperation[] = [];
  const createdDirs: string[] = [];
  try {
    for (const op of pending) {
      assertNoSymlinks(op.root, op.abs);
      const current = await readExisting(op.abs);
      const currentHash = current ? sha256(current) : null;
      if (currentHash !== op.beforeHash) throw new Error(`${op.display} changed after the preview was created. Preview the migration again.`);
      let d = dirname(op.abs);
      const toCreate: string[] = [];
      for (;;) {
        try {
          await fsp.lstat(d);
          break;
        } catch {
          toCreate.unshift(d);
          if (d === dirname(d)) break;
          d = dirname(d);
        }
      }
      for (const dir of toCreate) {
        await fsp.mkdir(dir);
        createdDirs.push(dir);
      }
      let mode = op.mode;
      if (current) mode = (await fsp.stat(op.abs)).mode & 0o777;
      await atomicWrite(op.abs, op.after!, mode);
      done.push(op);
    }
  } catch (e) {
    await rollback(done, createdDirs);
    throw e;
  }
  return { written: done };
}

export async function rollback(done: FileOperation[], createdDirs: string[]): Promise<void> {
  for (const op of [...done].reverse()) {
    try {
      if (op.before) await atomicWrite(op.abs, op.before);
      else await fsp.rm(op.abs, { force: true });
    } catch {
      /* best effort: the backup on disk is the fallback */
    }
  }
  for (const dir of [...createdDirs].reverse()) {
    try {
      await fsp.rmdir(dir);
    } catch {
      /* not empty */
    }
  }
}

export function relativeDisplay(op: FileOperation): string {
  return relative(op.root, op.abs);
}

export { join };
