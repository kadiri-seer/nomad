import { realpathSync } from "node:fs";

/**
 * Folders and files that can hold wallet keys or wallet state. Nomad never
 * reads them, never follows a symlink into them and never writes into them,
 * whatever options are set. The list is data so more tools can be added.
 */
export const KEY_MATERIAL_DIRS: RegExp[] = [
  /(^|\/)\.priors(\/|$)/,
  /(^|\/)\.config\/priors(\/|$)/,
  /(^|\/)\.local\/state\/priors-mcp(\/|$)/,
  /(^|\/)\.agent001(\/|$)/
];

/** Key files by name, wherever they are. */
export const KEY_MATERIAL_FILES: RegExp[] = [/(^|\/)agent(-\d+)?\.key$/];

function matches(p: string): boolean {
  const posix = p.replace(/\\/g, "/");
  return KEY_MATERIAL_DIRS.some((re) => re.test(posix)) || KEY_MATERIAL_FILES.some((re) => re.test(posix));
}

/** True for a key-material path, checked both as given and after resolving symlinks. */
export function isKeyMaterialPath(abs: string): boolean {
  if (matches(abs)) return true;
  try {
    return matches(realpathSync(abs));
  } catch {
    return false;
  }
}

const skipped = new Set<string>();

/** Remember a path that was refused, so the read can report it (paths only, never content). */
export function recordSkippedKeyMaterial(abs: string): void {
  skipped.add(abs);
}

/** Paths refused since the last call. */
export function drainSkippedKeyMaterial(): string[] {
  const out = [...skipped].sort();
  skipped.clear();
  return out;
}
