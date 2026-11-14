/**
 * Suggestions from the website. Anyone can suggest an app (no GitHub account, no wallet).
 * New suggestions wait here until the hourly round job turns them into GitHub issues; only
 * suggestions with an open GitHub issue are listed on the site, so closing an issue hides it.
 * People can back listed suggestions; backing adds to the thumbs-up count used to rank ballots.
 */
import { createHash, randomBytes } from "node:crypto";
import { hashToObject, type RedisLike } from "./redis";

export type PendingSuggestion = { id: string; name: string; why: string; createdAt: string };

/** A suggestion as published in governance/suggestions.json by the round job. */
export type PublishedSuggestion = { issue: number; name: string; approved: boolean; won: boolean; thumbs: number; source: "site" | "github" };

export const LIMITS = { submitsPerDay: 3, backsPerDay: 30, nameMax: 60, whyMax: 500, pendingMax: 500 };

const K = {
  pending: "nomad:suggest:pending",
  keys: "nomad:suggest:keys",
  support: "nomad:suggest:support",
  backers: (issue: number) => `nomad:suggest:backers:${issue}`,
  rate: (kind: string, fp: string, day: string) => `nomad:suggest:rate:${kind}:${fp}:${day}`
};

/** "Claude  Desktop!" and "claude-desktop" are the same suggestion. */
export function suggestionKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .replace(/[^\p{L}\p{N} .,+&()'/_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.nameMax)
    .trim();
  return name.length >= 2 && suggestionKey(name).length >= 2 ? name : null;
}

export function cleanWhy(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, LIMITS.whyMax)
    .trim();
}

/** A private, one-way tag for a visitor, used only for daily limits and one-back-per-person. */
export function visitorTag(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

export function clientIp(headers: Headers): string {
  return (headers.get("x-forwarded-for")?.split(",")[0] ?? headers.get("x-real-ip") ?? "unknown").trim();
}

const day = (now: Date) => now.toISOString().slice(0, 10);

export type SubmitResult =
  | { ok: true; status: "added"; id: string }
  | { ok: true; status: "duplicate"; issue: number | null }
  | { ok: false; status: number; error: string };

export class SuggestionStore {
  constructor(
    private redis: RedisLike,
    private salt: string
  ) {}

  private async underLimit(kind: string, tag: string, limit: number, now: Date) {
    const key = K.rate(kind, tag, day(now));
    const n = Number(await this.redis.cmd(["INCR", key]));
    if (n === 1) await this.redis.cmd(["EXPIRE", key, 172800]);
    return n <= limit;
  }

  async submit(input: { name: unknown; why: unknown; website?: unknown; ip: string; now: Date; published: PublishedSuggestion[] }): Promise<SubmitResult> {
    // A hidden field people never see; bots fill it in.
    if (typeof input.website === "string" && input.website.trim() !== "") return { ok: true, status: "added", id: "ignored" };
    const name = cleanName(input.name);
    if (!name) return { ok: false, status: 400, error: "Give the app's name (at least two letters or numbers)." };
    const why = cleanWhy(input.why);
    const key = suggestionKey(name);
    const listed = input.published.find((p) => suggestionKey(p.name) === key);
    if (listed) return { ok: true, status: "duplicate", issue: listed.issue };
    const tag = visitorTag(input.ip, this.salt);
    if (!(await this.underLimit("submit", tag, LIMITS.submitsPerDay, input.now))) return { ok: false, status: 429, error: "You have sent the most suggestions allowed today. Try again tomorrow." };
    const id = `s${input.now.getTime().toString(36)}${randomBytes(3).toString("hex")}`;
    const fresh = await this.redis.cmd(["HSETNX", K.keys, key, id]);
    if (fresh !== 1 && fresh !== "1") return { ok: true, status: "duplicate", issue: null };
    const record: PendingSuggestion = { id, name, why, createdAt: input.now.toISOString() };
    await this.redis.cmd(["HSET", K.pending, id, JSON.stringify(record)]);
    return { ok: true, status: "added", id };
  }

  async pending(): Promise<PendingSuggestion[]> {
    const all = Object.values(hashToObject(await this.redis.cmd(["HGETALL", K.pending])))
      .map((raw) => {
        try {
          return JSON.parse(raw) as PendingSuggestion;
        } catch {
          return null;
        }
      })
      .filter((s): s is PendingSuggestion => !!s && typeof s.id === "string" && typeof s.name === "string");
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-LIMITS.pendingMax);
  }

  async back(input: { issue: unknown; ip: string; now: Date; published: PublishedSuggestion[] }): Promise<{ ok: true; support: number; already: boolean } | { ok: false; status: number; error: string }> {
    const issue = Number(input.issue);
    if (!Number.isInteger(issue) || !input.published.some((p) => p.issue === issue)) return { ok: false, status: 404, error: "That suggestion is not in the list." };
    const tag = visitorTag(input.ip, this.salt);
    if (!(await this.underLimit("back", tag, LIMITS.backsPerDay, input.now))) return { ok: false, status: 429, error: "You have backed the most suggestions allowed today." };
    const added = await this.redis.cmd(["SADD", K.backers(issue), tag]);
    if (added !== 1 && added !== "1") return { ok: true, support: await this.supportFor(issue), already: true };
    const support = Number(await this.redis.cmd(["HINCRBY", K.support, String(issue), 1]));
    return { ok: true, support, already: false };
  }

  async supportMap(): Promise<Record<string, number>> {
    return Object.fromEntries(Object.entries(hashToObject(await this.redis.cmd(["HGETALL", K.support]))).map(([k, v]) => [k, Number(v) || 0]));
  }

  private async supportFor(issue: number) {
    return Number((await this.redis.cmd(["HGET", K.support, String(issue)])) ?? 0) || 0;
  }
}

/** The text of the GitHub issue created for a site suggestion. Mentions are defused. */
export function suggestionIssueBody(s: PendingSuggestion): string {
  const quote = (t: string) =>
    t
      .replace(/@/g, "@​")
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
  return [`Suggested on the Nomad website.`, ``, s.why ? `**Why it should be next**\n\n${quote(s.why)}` : `No reason was given.`, ``, `Add the \`approved\` label if it can be built safely; it then goes on a holder vote.`, ``, `<!-- nomad-suggestion: ${s.id} -->`].join("\n");
}

export function suggestionMarker(body: string | null | undefined): string | null {
  const m = /<!-- nomad-suggestion: (s[0-9a-z]+) -->/.exec(body ?? "");
  return m ? m[1] : null;
}
