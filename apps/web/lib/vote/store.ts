/**
 * Where votes are kept. On the website this is the Upstash Redis database connected in
 * Vercel; every key starts with `nomad:` so it can share a database with other projects.
 */
import type { Vote } from "./core";
import { findRedisEnv } from "./redis";

export interface VoteStore {
  /** Saves the vote only if this wallet has not voted in this round. Returns false if it had. */
  addVote(vote: Vote): Promise<boolean>;
  getVote(round: number, address: string): Promise<Vote | null>;
  listVotes(round: number): Promise<Vote[]>;
}

export const KEY_PREFIX = "nomad:";
export const votesKey = (round: number) => `${KEY_PREFIX}vote:round:${round}`;

function parseVote(raw: unknown): Vote | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Vote;
    return v && typeof v.address === "string" && typeof v.choice === "string" ? v : null;
  } catch {
    return null;
  }
}

export class MemoryVoteStore implements VoteStore {
  private data = new Map<string, Map<string, string>>();
  async addVote(vote: Vote) {
    const key = votesKey(vote.round);
    const h = this.data.get(key) ?? new Map<string, string>();
    this.data.set(key, h);
    if (h.has(vote.address)) return false;
    h.set(vote.address, JSON.stringify(vote));
    return true;
  }
  async getVote(round: number, address: string) {
    return parseVote(this.data.get(votesKey(round))?.get(address.toLowerCase()));
  }
  async listVotes(round: number) {
    return [...(this.data.get(votesKey(round))?.values() ?? [])].map(parseVote).filter((v): v is Vote => v !== null);
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Talks to Upstash over its REST API, so no extra package is needed. */
export class UpstashVoteStore implements VoteStore {
  constructor(
    private url: string,
    private token: string,
    private fetchImpl: FetchLike = fetch
  ) {}

  private async command(args: (string | number)[]): Promise<unknown> {
    const res = await this.fetchImpl(this.url.replace(/\/$/, ""), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store"
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || body.error) throw new Error(`Vote storage error: ${body.error ?? res.status}`);
    return body.result;
  }

  async addVote(vote: Vote) {
    const r = await this.command(["HSETNX", votesKey(vote.round), vote.address, JSON.stringify(vote)]);
    return r === 1 || r === "1";
  }
  async getVote(round: number, address: string) {
    return parseVote(await this.command(["HGET", votesKey(round), address.toLowerCase()]));
  }
  async listVotes(round: number) {
    const r = await this.command(["HGETALL", votesKey(round)]);
    const out: Vote[] = [];
    if (Array.isArray(r)) {
      for (let i = 1; i < r.length; i += 2) {
        const v = parseVote(r[i]);
        if (v) out.push(v);
      }
    } else if (r && typeof r === "object") {
      for (const raw of Object.values(r)) {
        const v = parseVote(raw);
        if (v) out.push(v);
      }
    }
    return out;
  }
}

/** Picks up the connection that Vercel's Upstash integration adds to the project. */
export function storeFromEnv(env: Record<string, string | undefined> = process.env): VoteStore | null {
  const found = findRedisEnv(env);
  return found ? new UpstashVoteStore(found.url, found.token) : null;
}
