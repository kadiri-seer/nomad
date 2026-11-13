import { constants, promises as fsp, lstatSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from "node:path";
import { randomBytes } from "node:crypto";
import { isKeyMaterialPath, recordSkippedKeyMaterial } from "./keymaterial";

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

export function home(): string {
  return process.env.NOMAD_FAKE_HOME || homedir();
}

export function expandHome(p: string): string {
  if (p === "~") return home();
  if (p.startsWith("~/")) return join(home(), p.slice(2));
  return p;
}

/** Nomad's own state directory. */
export function nomadHome(): string {
  return process.env.NOMAD_HOME ? resolve(process.env.NOMAD_HOME) : join(home(), ".nomad");
}

/** Resolve a user supplied root. The root itself may be a symlink (for example a dotfiles checkout). */
export function resolveRoot(p: string): string {
  const abs = resolve(expandHome(p));
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Validate a relative POSIX path from an adapter or an archive. */
export function assertSafeRelative(rel: string): void {
  if (!rel || rel.includes("\0")) throw new UnsafePathError(`Invalid path "${rel}"`);
  if (rel.includes("\\")) throw new UnsafePathError(`Backslashes are not allowed in "${rel}"`);
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new UnsafePathError(`Absolute paths are not allowed: "${rel}"`);
  const norm = posix.normalize(rel);
  if (norm.startsWith("../") || norm === ".." || norm.split("/").includes("..")) {
    throw new UnsafePathError(`Path escapes its root: "${rel}"`);
  }
}

/** Join a relative path onto a root and guarantee the result stays inside it. */
export function safeJoin(root: string, rel: string): string {
  assertSafeRelative(rel);
  const abs = resolve(root, ...rel.split("/"));
  const r = relative(root, abs);
  if (r.startsWith("..") || isAbsolute(r)) throw new UnsafePathError(`Path escapes its root: "${rel}"`);
  assertNotKeyMaterial(abs);
  return abs;
}

/** Writing into a folder that can hold wallet keys is always refused. */
export function assertNotKeyMaterial(abs: string): void {
  if (isKeyMaterialPath(abs)) throw new UnsafePathError(`Refusing to touch ${abs}: it can hold wallet keys.`);
}

/**
 * Refuse to write through symlinks below the root. Every existing component of
 * the target path, including the file itself, must be a real file or directory.
 */
export function assertNoSymlinks(root: string, abs: string): void {
  const r = relative(root, abs);
  if (r.startsWith("..")) throw new UnsafePathError(`${abs} is outside ${root}`);
  let cur = root;
  for (const part of r.split(sep).filter(Boolean)) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return; // the rest does not exist yet
    }
    if (st.isSymbolicLink()) {
      throw new UnsafePathError(`Refusing to follow symlink at ${cur}`);
    }
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(p: string): boolean {
  return existsSync(p);
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Read a text file. Returns null when missing. Refuses symlinks unless allowed. */
export async function readTextIfExists(p: string, maxBytes = 10 * 1024 * 1024): Promise<string | null> {
  if (isKeyMaterialPath(p)) {
    if (await pathExists(p)) recordSkippedKeyMaterial(p);
    return null;
  }
  try {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) {
      const real = await fsp.stat(p);
      if (!real.isFile()) return null;
    } else if (!st.isFile()) return null;
    if (st.size > maxBytes) throw new Error(`${p} is larger than ${maxBytes} bytes`);
    return await fsp.readFile(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function readBytesIfExists(p: string): Promise<Uint8Array | null> {
  if (isKeyMaterialPath(p)) {
    if (await pathExists(p)) recordSkippedKeyMaterial(p);
    return null;
  }
  try {
    return new Uint8Array(await fsp.readFile(p));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function listDir(p: string): Promise<Array<{ name: string; dir: boolean; file: boolean; symlink: boolean }>> {
  try {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return entries
      .map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile(), symlink: e.isSymbolicLink() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export interface WalkOptions {
  maxFiles?: number;
  maxDepth?: number;
  skip?: (rel: string, isDir: boolean) => boolean;
}

/** Recursively list files (relative POSIX paths). Symlinks are never followed. */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
  const out: string[] = [];
  const maxFiles = options.maxFiles ?? 5000;
  const maxDepth = options.maxDepth ?? 12;
  async function rec(dir: string, rel: string, depth: number) {
    if (depth > maxDepth || out.length >= maxFiles) return;
    for (const e of await listDir(dir)) {
      if (e.symlink) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (isKeyMaterialPath(join(dir, e.name))) {
        recordSkippedKeyMaterial(join(dir, e.name));
        continue;
      }
      if (options.skip?.(r, e.dir)) continue;
      if (e.dir) await rec(join(dir, e.name), r, depth + 1);
      else if (e.file) {
        out.push(r);
        if (out.length >= maxFiles) return;
      }
    }
  }
  await rec(root, "", 0);
  return out;
}

/** Write atomically: temp file in the same directory, fsync, rename. */
export async function atomicWrite(abs: string, data: string | Uint8Array, mode?: number): Promise<void> {
  assertNotKeyMaterial(abs);
  await fsp.mkdir(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${posix.basename(abs.split(sep).join("/"))}.nomad-tmp-${randomBytes(6).toString("hex")}`);
  const fh = await fsp.open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode ?? 0o644);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, abs);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  if (mode !== undefined) await fsp.chmod(abs, mode);
}

export async function ensureDir(p: string, mode = 0o700): Promise<void> {
  await fsp.mkdir(p, { recursive: true, mode });
}

export async function makeTempDir(prefix = "nomad-"): Promise<string> {
  const { tmpdir } = await import("node:os");
  return fsp.mkdtemp(join(tmpdir(), prefix));
}

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export function displayPath(p: string): string {
  // Compare against the real home path too: on macOS /var is a link to /private/var.
  for (const h of new Set([home(), realHome()])) if (p === h || p.startsWith(h + sep)) return p === h ? "~" : "~/" + toPosix(relative(h, p));
  return p;
}

function realHome(): string {
  try {
    return realpathSync(home());
  } catch {
    return home();
  }
}
