import { join } from "node:path";
import type { Adapter, AdapterInfo, AgentRef, DetectResult } from "@nomad/core";
import { expandHome, isDirectory } from "@nomad/core/node";
import { genericAdapter } from "./generic";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { openclawAdapter } from "./openclaw";
import { hermesAdapter } from "./hermes";
import { elizaosAdapter } from "./elizaos";
import { FILE_ADAPTERS } from "./file-based";
import { GUIDED_ADAPTERS } from "./guided";

const registry = new Map<string, Adapter>();

export function registerAdapter(adapter: Adapter): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(adapter.info.id)) throw new Error(`Invalid adapter id "${adapter.info.id}"`);
  registry.set(adapter.info.id, adapter);
}

for (const a of [openclawAdapter, claudeCodeAdapter, codexAdapter, hermesAdapter, genericAdapter, elizaosAdapter, ...FILE_ADAPTERS, ...GUIDED_ADAPTERS]) registerAdapter(a);

export function getAdapter(id: string): Adapter {
  const a = registry.get(id);
  if (!a) throw new Error(`Unknown platform "${id}". Run "nomad adapters" to see the supported platforms.`);
  return a;
}

export function findAdapter(id: string): Adapter | undefined {
  return registry.get(id);
}

export function listAdapters(): Adapter[] {
  return [...registry.values()];
}

export function adapterInfos(): AdapterInfo[] {
  return listAdapters().map((a) => a.info);
}

export interface DetectedPlatform {
  adapter: string;
  displayName: string;
  root: string;
  detection: DetectResult;
  agents: AgentRef[];
}

/** Look for supported platforms at their default locations (and any extra roots). */
export async function scanPlatforms(extraRoots: Array<{ adapter: string; root: string }> = []): Promise<DetectedPlatform[]> {
  const out: DetectedPlatform[] = [];
  const candidates: Array<{ adapter: Adapter; root: string }> = [];
  for (const a of listAdapters()) for (const loc of a.info.defaultLocations) candidates.push({ adapter: a, root: expandHome(loc) });
  for (const e of extraRoots) candidates.push({ adapter: getAdapter(e.adapter), root: expandHome(e.root) });
  // Platforms that let users move their state directory with an environment variable.
  if (process.env.OPENCLAW_STATE_DIR) candidates.push({ adapter: getAdapter("openclaw"), root: expandHome(process.env.OPENCLAW_STATE_DIR) });
  if (process.env.CODEX_HOME) candidates.push({ adapter: getAdapter("codex"), root: expandHome(process.env.CODEX_HOME) });
  if (process.env.CLAUDE_CONFIG_DIR) candidates.push({ adapter: getAdapter("claude-code"), root: expandHome(process.env.CLAUDE_CONFIG_DIR) });
  for (const c of candidates) {
    if (!(await isDirectory(c.root))) continue;
    try {
      const detection = await c.adapter.detect(c.root);
      if (!detection.detected) continue;
      const agents = await c.adapter.discover(c.root);
      out.push({ adapter: c.adapter.info.id, displayName: c.adapter.info.displayName, root: c.root, detection, agents });
    } catch {
      /* unreadable location: skip */
    }
  }
  return out;
}

/** Guess which adapter fits a folder. */
export async function detectAdapterFor(root: string): Promise<{ adapter: Adapter; detection: DetectResult } | null> {
  let best: { adapter: Adapter; detection: DetectResult } | null = null;
  for (const a of listAdapters()) {
    if (a.info.support === "GUIDED") continue;
    const d = await a.detect(root);
    if (d.detected && (!best || d.confidence > best.detection.confidence)) best = { adapter: a, detection: d };
  }
  return best;
}

export { join };
