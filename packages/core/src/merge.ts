import { canonicalJson } from "./hash";

export interface MergeConflict {
  path: string;
  existing: unknown;
  incoming: unknown;
  resolution: "kept-existing" | "used-incoming";
}

export interface MergeResult {
  value: unknown;
  conflicts: MergeConflict[];
  added: string[];
}

export interface MergeOptions {
  mode: "merge" | "replace";
  /** Map of dotted path (with * wildcards) to the key used to match array items. */
  arrayKeys?: Record<string, string>;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function same(a: unknown, b: unknown) {
  return canonicalJson(a) === canonicalJson(b);
}

function keyFor(path: string, arrayKeys: Record<string, string> | undefined): string | undefined {
  if (!arrayKeys) return undefined;
  for (const [pattern, key] of Object.entries(arrayKeys)) {
    const re = new RegExp("^" + pattern.split(".").map((p) => (p === "*" ? "[^.]+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("\\.") + "$");
    if (re.test(path)) return key;
  }
  return undefined;
}

/**
 * Structured merge used for configuration files.
 *
 * merge mode: existing values win, incoming content is added where absent.
 * replace mode: incoming values win for the keys they define. Keys the incoming
 * document does not mention are always preserved, so unrelated configuration in
 * shared files is never destroyed.
 */
export function deepMerge(existing: unknown, incoming: unknown, options: MergeOptions, path = ""): MergeResult {
  const conflicts: MergeConflict[] = [];
  const added: string[] = [];

  function walk(a: unknown, b: unknown, p: string): unknown {
    if (a === undefined) {
      added.push(p || "(root)");
      return b;
    }
    if (b === undefined) return a;
    if (isPlainObject(a) && isPlainObject(b)) {
      const out: Record<string, unknown> = { ...a };
      for (const [k, v] of Object.entries(b)) {
        out[k] = walk(a[k], v, p ? `${p}.${k}` : k);
      }
      return out;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const key = keyFor(p, options.arrayKeys);
      if (key) {
        const out = [...a];
        for (const item of b) {
          const id = isPlainObject(item) ? item[key] : undefined;
          const idx = id === undefined ? -1 : out.findIndex((x) => isPlainObject(x) && x[key] === id);
          if (idx === -1) {
            out.push(item);
            added.push(`${p}[${String(id ?? out.length - 1)}]`);
          } else if (!same(out[idx], item)) {
            const resolution = options.mode === "replace" ? "used-incoming" : "kept-existing";
            conflicts.push({ path: `${p}[${String(id)}]`, existing: out[idx], incoming: item, resolution });
            if (options.mode === "replace") out[idx] = item;
          }
        }
        return out;
      }
      if (b.every((x) => !isPlainObject(x) && !Array.isArray(x)) && a.every((x) => !isPlainObject(x) && !Array.isArray(x))) {
        const out = [...a];
        for (const item of b) if (!out.some((x) => same(x, item))) {
          out.push(item);
          added.push(`${p}[]`);
        }
        return out;
      }
      if (same(a, b)) return a;
      const resolution = options.mode === "replace" ? "used-incoming" : "kept-existing";
      conflicts.push({ path: p, existing: a, incoming: b, resolution });
      return options.mode === "replace" ? b : a;
    }
    if (same(a, b)) return a;
    const resolution = options.mode === "replace" ? "used-incoming" : "kept-existing";
    conflicts.push({ path: p || "(root)", existing: a, incoming: b, resolution });
    return options.mode === "replace" ? b : a;
  }

  const value = walk(existing, incoming, path);
  return { value, conflicts, added };
}

/** Union of delimited entries (order preserving, exact duplicates removed). */
export function mergeEntries(existing: string, incoming: string, delimiter: string): { value: string; added: number; duplicates: number } {
  const split = (s: string) =>
    s
      .split(delimiter)
      .map((e) => e.trim())
      .filter(Boolean);
  const a = split(existing);
  const seen = new Set(a.map((e) => e.replace(/\s+/g, " ")));
  let added = 0;
  let duplicates = 0;
  for (const e of split(incoming)) {
    const norm = e.replace(/\s+/g, " ");
    if (seen.has(norm)) {
      duplicates++;
      continue;
    }
    seen.add(norm);
    a.push(e);
    added++;
  }
  const sep = delimiter.trim() === delimiter ? `\n${delimiter}\n` : delimiter;
  return { value: a.join(sep) + (a.length ? "\n" : ""), added, duplicates };
}
