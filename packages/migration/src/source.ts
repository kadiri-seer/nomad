import { existsSync, statSync } from "node:fs";
import { findAdapter, detectAdapterFor, getAdapter } from "@nomad/adapters";
import { NomadError } from "@nomad/core";
import { expandHome, resolveRoot } from "@nomad/core/node";
import type { Nomad, SourceSpec } from "./engine";

/**
 * Accepted source forms:
 *   ./agent.agentpack          a package file
 *   openclaw                   platform at its default location (first agent)
 *   openclaw:~/.openclaw#main  platform, root and agent
 *   01J...ULID or "Kestrel"    an agent in the local library (optionally @3 for version 3)
 *   ./some/folder              a folder, platform detected automatically
 */
export async function parseSource(nomad: Nomad, spec: string, opts: { sourceDir?: string; agent?: string } = {}): Promise<SourceSpec> {
  const expanded = expandHome(spec);
  if (/\.agentpack$/i.test(spec) && existsSync(expanded)) return { kind: "package", path: expanded };

  const m = /^([a-z0-9-]+)(?::(.*?))?(?:#(.+))?$/.exec(spec);
  const adapter = m ? findAdapter(m[1]) : undefined;
  if (adapter && m) {
    const root = opts.sourceDir ?? m[2] ?? adapter.info.defaultLocations[0];
    if (!root) throw new NomadError(`${adapter.info.displayName} has no default location. Pass it as ${m[1]}:<path> or with --source-dir.`, "usage");
    const nativeId = opts.agent ?? m[3] ?? (await firstAgent(adapter.info.id, root));
    return { kind: "location", adapter: adapter.info.id, root: resolveRoot(root), nativeId };
  }

  const vm = /^(.+?)@(\d+)$/.exec(spec);
  const stored = nomad.store.resolveAgent(vm ? vm[1] : spec);
  if (stored) return { kind: "stored", agentId: stored.id, version: vm ? Number(vm[2]) : undefined };

  if (existsSync(expanded) && statSync(expanded).isDirectory()) {
    const found = await detectAdapterFor(resolveRoot(expanded));
    if (!found) throw new NomadError(`No supported platform was found in ${spec}.`, "not-found", 'Name the platform explicitly, for example "claude-code:./my-project".');
    const nativeId = opts.agent ?? (await firstAgent(found.adapter.info.id, expanded));
    return { kind: "location", adapter: found.adapter.info.id, root: resolveRoot(expanded), nativeId };
  }
  throw new NomadError(`Could not understand the source "${spec}".`, "usage", 'Use a package path, a platform such as "openclaw" or "claude-code:~/project", or an agent from "nomad list".');
}

async function firstAgent(adapterId: string, root: string): Promise<string> {
  const refs = await getAdapter(adapterId).discover(resolveRoot(root));
  if (!refs.length) throw new NomadError(`No agent found for ${adapterId} at ${root}.`, "not-found");
  return refs[0].nativeId;
}
