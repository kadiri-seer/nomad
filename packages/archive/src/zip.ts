import { Inflate, zipSync, type Zippable } from "fflate";

/**
 * Minimal ZIP reader that inspects the central directory before anything is
 * decompressed. This lets us reject traversal, symlinks, encrypted entries,
 * duplicates and decompression bombs from declared metadata, and then enforce
 * the declared sizes while inflating.
 */

export interface ArchiveLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
  maxRatio: number;
  maxPathLength: number;
  maxArchiveBytes: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: 10_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxRatio: 250,
  maxPathLength: 512,
  maxArchiveBytes: 128 * 1024 * 1024
};

export class ArchiveError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly entry?: string
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  isDirectory: boolean;
  unixMode?: number;
}

const ALLOWED_EXTENSIONS = new Set([
  "md", "markdown", "txt", "json", "jsonl", "json5", "yaml", "yml", "toml", "csv", "tsv", "xml", "html", "css",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "ico",
  "js", "mjs", "cjs", "ts", "py", "sh", "bash", "zsh", "rb", "go", "rs", "lua", "sql", "ini", "cfg", "conf", "env", "lock", "mdc", "rst", "tex", "ipynb", "pem", "key"
]);

export const EXECUTABLE_EXTENSIONS = new Set(["js", "mjs", "cjs", "ts", "py", "sh", "bash", "zsh", "rb", "go", "rs", "lua"]);

export function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

function checkEntryName(name: string, limits: ArchiveLimits): void {
  if (name.length > limits.maxPathLength) throw new ArchiveError(`Entry name is too long`, "path-too-long", name.slice(0, 80));
  if (name.includes("\0") || /[\u0001-\u001f\u007f]/.test(name)) throw new ArchiveError(`Entry name contains control characters`, "unsafe-name", name);
  if (name.includes("\\")) throw new ArchiveError(`Entry name contains backslashes`, "unsafe-name", name);
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) throw new ArchiveError(`Entry uses an absolute path`, "absolute-path", name);
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.some((p) => p === ".." )) throw new ArchiveError(`Entry escapes the archive root`, "path-traversal", name);
  if (parts.some((p) => p === "" || p === ".")) throw new ArchiveError(`Entry has an empty path segment`, "unsafe-name", name);
  if (parts.some((p) => p.length > 255)) throw new ArchiveError(`Entry has a path segment longer than 255 characters`, "unsafe-name", name);
}

export function listEntries(bytes: Uint8Array, limits: ArchiveLimits = DEFAULT_LIMITS): ZipEntry[] {
  if (bytes.length > limits.maxArchiveBytes) throw new ArchiveError(`Archive is larger than ${limits.maxArchiveBytes} bytes`, "archive-too-large");
  if (bytes.length < 22) throw new ArchiveError("Not a ZIP archive", "not-zip");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError("Not a ZIP archive (no end of central directory)", "not-zip");
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ArchiveError("ZIP64 archives are not supported", "zip64");
  if (count > limits.maxEntries) throw new ArchiveError(`Archive has ${count} entries, more than the limit of ${limits.maxEntries}`, "too-many-entries");
  if (cdOffset + cdSize > bytes.length) throw new ArchiveError("Corrupt central directory", "corrupt");

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new ArchiveError("Corrupt central directory entry", "corrupt");
    const madeBy = view.getUint16(p + 4, true);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const extAttr = view.getUint32(p + 38, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    checkEntryName(name, limits);
    if (flags & 0x1) throw new ArchiveError("Encrypted entries are not supported", "encrypted", name);
    const isDirectory = name.endsWith("/");
    const host = madeBy >> 8;
    const unixMode = host === 3 ? extAttr >>> 16 : undefined;
    if (unixMode !== undefined && (unixMode & 0o170000) === 0o120000) throw new ArchiveError("Symbolic links are not allowed in packages", "symlink", name);
    if (unixMode !== undefined && (unixMode & 0o170000) !== 0 && (unixMode & 0o170000) !== 0o100000 && (unixMode & 0o170000) !== 0o040000) {
      throw new ArchiveError("Special files are not allowed in packages", "special-file", name);
    }
    if (method !== 0 && method !== 8) throw new ArchiveError(`Unsupported compression method ${method}`, "unsupported-method", name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ArchiveError("Duplicate path in archive", "duplicate-path", name);
    seen.add(key);
    if (!isDirectory) {
      const ext = extensionOf(name);
      if (ext && !ALLOWED_EXTENSIONS.has(ext)) throw new ArchiveError(`File type .${ext} is not allowed in packages`, "file-type", name);
      if (size > limits.maxEntryBytes) throw new ArchiveError(`Entry is larger than ${limits.maxEntryBytes} bytes`, "entry-too-large", name);
      if (compressedSize > 0 && size / compressedSize > limits.maxRatio && size > 1024 * 1024) {
        throw new ArchiveError("Compression ratio suggests a decompression bomb", "bomb", name);
      }
      if (method === 0 && compressedSize !== size) throw new ArchiveError("Stored entry size mismatch", "corrupt", name);
      total += size;
      if (total > limits.maxTotalBytes) throw new ArchiveError(`Archive expands beyond ${limits.maxTotalBytes} bytes`, "bomb");
    }
    entries.push({ name, method, compressedSize, size, localOffset, isDirectory, unixMode });
  }
  return entries;
}

function inflateCapped(data: Uint8Array, expected: number, name: string): Uint8Array {
  const out = new Uint8Array(expected);
  let written = 0;
  let overflow = false;
  const inflater = new Inflate((chunk) => {
    if (written + chunk.length > expected) {
      overflow = true;
      return;
    }
    out.set(chunk, written);
    written += chunk.length;
  });
  const step = 64 * 1024;
  for (let i = 0; i < data.length && !overflow; i += step) {
    inflater.push(data.subarray(i, Math.min(data.length, i + step)), i + step >= data.length);
  }
  if (overflow) throw new ArchiveError("Entry inflates beyond its declared size", "bomb", name);
  if (written !== expected) throw new ArchiveError("Entry size does not match its declared size", "corrupt", name);
  return out;
}

export function extractEntries(bytes: Uint8Array, limits: ArchiveLimits = DEFAULT_LIMITS): Map<string, Uint8Array> {
  const entries = listEntries(bytes, limits);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (e.isDirectory) continue;
    const lo = e.localOffset;
    if (lo + 30 > bytes.length || view.getUint32(lo, true) !== 0x04034b50) throw new ArchiveError("Corrupt local header", "corrupt", e.name);
    const nameLen = view.getUint16(lo + 26, true);
    const extraLen = view.getUint16(lo + 28, true);
    const start = lo + 30 + nameLen + extraLen;
    const end = start + e.compressedSize;
    if (end > bytes.length) throw new ArchiveError("Entry data is truncated", "corrupt", e.name);
    const raw = bytes.subarray(start, end);
    files.set(e.name, e.method === 0 ? raw.slice() : inflateCapped(raw, e.size, e.name));
  }
  return files;
}

/** Deterministic archive: sorted entries and a fixed timestamp. */
export function createZip(files: Map<string, Uint8Array>): Uint8Array {
  const input: Zippable = {};
  for (const name of [...files.keys()].sort()) {
    input[name] = [files.get(name)!, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") }];
  }
  return zipSync(input);
}
