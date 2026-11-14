/**
 * Reads published rounds. Rounds live in the repository under `governance/rounds/`, written by
 * the GitHub round job, so the ballot and the balance snapshot are public and versioned.
 * The website reads them straight from GitHub, so a new round shows up without a redeploy.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Holders, Round } from "./core";

export const DEFAULT_GOVERNANCE_URL = "https://raw.githubusercontent.com/kadiri-seer/nomad/main/governance";

export type RoundIndex = { latest: number };

type Source = { kind: "url"; base: string } | { kind: "dir"; base: string };

export function governanceSource(env: Record<string, string | undefined> = process.env): Source {
  const v = env.NOMAD_GOVERNANCE_SOURCE;
  if (v && !/^https?:\/\//.test(v)) return { kind: "dir", base: v };
  return { kind: "url", base: (v ?? DEFAULT_GOVERNANCE_URL).replace(/\/$/, "") };
}

const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 30_000;

async function readJson<T>(source: Source, path: string): Promise<T | null> {
  const key = `${source.kind}:${source.base}/${path}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T | null;
  let value: T | null;
  if (source.kind === "dir") {
    try {
      value = JSON.parse(await readFile(join(source.base, path), "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") value = null;
      else throw e;
    }
  } else {
    // The minute bucket keeps GitHub's cache from serving a stale round for long.
    const bucket = Math.floor(Date.now() / 60_000);
    const res = await fetch(`${source.base}/${path}?v=${bucket}`, { cache: "no-store" });
    if (res.status === 404) value = null;
    else if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
    else value = (await res.json()) as T;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function loadIndex(source = governanceSource()): Promise<RoundIndex> {
  return (await readJson<RoundIndex>(source, "rounds/index.json")) ?? { latest: 0 };
}

export async function loadRound(id: number, source = governanceSource()): Promise<Round | null> {
  if (!Number.isInteger(id) || id < 1) return null;
  return readJson<Round>(source, `rounds/round-${id}.json`);
}

export async function loadHolders(id: number, source = governanceSource()): Promise<Holders> {
  return (await readJson<Holders>(source, `rounds/round-${id}-holders.json`)) ?? {};
}

export function clearRoundCache() {
  cache.clear();
}
