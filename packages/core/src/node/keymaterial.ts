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
  /(^|\/)\.agent001(\/|$)/,
  // Oak Agent Kit: the encrypted wallet (wallet.enc), private notes (*.gloam.enc), the wallet journal and settings.
  /(^|\/)\.oak(\/|$)/,
  // Hedgehood: the session, payer and owner key files and the kit's settings.
  /(^|\/)\.hedgehood(\/|$)/,
  // BrainChain: the payer and worker key files and the daily spending record (~/.brainchain), and the worker's state.
  /(^|\/)\.brainchain(\/|$)/,
  /(^|\/)\.config\/brainchain-worker(\/|$)/,
  // Rushr: the agent wallet made by create_wallet, the registered API key and the daily spend ledger.
  /(^|\/)\.rushr(\/|$)/
];

/** Key files by name, wherever they are. */
export const KEY_MATERIAL_FILES: RegExp[] = [
  /(^|\/)agent(-\d+)?\.key$/,
  // Rushr's and its Talos example agent's wallet file ({ "privateKey": ... }), wherever it is kept.
  /(^|\/)\.?agent-wallet\.json$/
];

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
