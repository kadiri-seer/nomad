import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanName, cleanWhy, LIMITS, suggestionIssueBody, suggestionKey, suggestionMarker, SuggestionStore, visitorTag, type PublishedSuggestion } from "../../apps/web/lib/vote/suggest";
import { hashToObject, MemoryRedis, redisFromEnv, UpstashRedis } from "../../apps/web/lib/vote/redis";
import { backing, importSuggestions, pickBallot, publishSuggestions, readConfig, type GitHubApi, type Issue, type JobDeps } from "../../apps/web/lib/vote/job";

const ROOT = resolve(__dirname, "../..");
const NOW = new Date("2026-12-01T10:00:00Z");

describe("suggestion text", () => {
  it("cleans names and treats spelling variants as the same app", () => {
    expect(cleanName("  Claude   Desktop!!\n<script> ")).toBe("Claude Desktop script");
    expect(cleanName("x")).toBeNull();
    expect(cleanName("!!")).toBeNull();
    expect(cleanName(42)).toBeNull();
    expect(cleanName("a".repeat(100))).toHaveLength(LIMITS.nameMax);
    expect(suggestionKey("Claude Desktop")).toBe(suggestionKey("claude-desktop"));
  });

  it("keeps reasons short and strips control characters", () => {
    expect(cleanWhy("line one\r\n\n\n\nline two\u0007")).toBe("line one\n\nline two");
    expect(cleanWhy("z".repeat(900))).toHaveLength(LIMITS.whyMax);
    expect(cleanWhy(undefined)).toBe("");
  });

  it("writes an issue body with mentions defused and a marker the job can find", () => {
    const body = suggestionIssueBody({ id: "sabc123", name: "Zed", why: "ask @someone\nsecond line", createdAt: NOW.toISOString() });
    expect(body).toContain("> ask @​someone\n> second line");
    expect(body).not.toMatch(/@someone/);
    expect(suggestionMarker(body)).toBe("sabc123");
    expect(suggestionMarker("no marker")).toBeNull();
  });

  it("tags visitors without storing their address", () => {
    const tag = visitorTag("203.0.113.9", "salt");
    expect(tag).toMatch(/^[0-9a-f]{32}$/);
    expect(tag).not.toContain("203");
    expect(visitorTag("203.0.113.9", "other")).not.toBe(tag);
  });
});

describe("suggestion store", () => {
  const published: PublishedSuggestion[] = [{ issue: 41, name: "Claude Desktop", approved: false, won: false, thumbs: 2, source: "site" }];
  const make = () => new SuggestionStore(new MemoryRedis(), "salt");

  it("adds a suggestion and lists it for the job", async () => {
    const s = make();
    const r = await s.submit({ name: "Zed", why: "fast editor", ip: "1.1.1.1", now: NOW, published });
    expect(r).toMatchObject({ ok: true, status: "added" });
    const pending = await s.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ name: "Zed", why: "fast editor", createdAt: NOW.toISOString() });
  });

  it("points repeats at the listed or waiting suggestion instead of adding them", async () => {
    const s = make();
    expect(await s.submit({ name: "claude-desktop", why: "", ip: "1.1.1.1", now: NOW, published })).toEqual({ ok: true, status: "duplicate", issue: 41 });
    await s.submit({ name: "Zed", why: "", ip: "1.1.1.1", now: NOW, published });
    expect(await s.submit({ name: "ZED", why: "", ip: "2.2.2.2", now: NOW, published })).toEqual({ ok: true, status: "duplicate", issue: null });
    expect(await s.pending()).toHaveLength(1);
  });

  it("limits each person to a few suggestions a day", async () => {
    const s = make();
    for (const name of ["Aa", "Bb", "Cc"]) expect((await s.submit({ name, why: "", ip: "9.9.9.9", now: NOW, published })).ok).toBe(true);
    expect(await s.submit({ name: "Dd", why: "", ip: "9.9.9.9", now: NOW, published })).toMatchObject({ ok: false, status: 429 });
    expect((await s.submit({ name: "Dd", why: "", ip: "9.9.9.9", now: new Date("2026-12-02T10:00:00Z"), published })).ok).toBe(true);
    expect((await s.submit({ name: "Ee", why: "", ip: "8.8.8.8", now: NOW, published })).ok).toBe(true);
  });

  it("quietly drops submissions that fill the hidden field, and rejects empty names", async () => {
    const s = make();
    expect(await s.submit({ name: "Spam", why: "", website: "http://spam", ip: "1.1.1.1", now: NOW, published })).toMatchObject({ ok: true, status: "added" });
    expect(await s.pending()).toHaveLength(0);
    expect(await s.submit({ name: " ", why: "", ip: "1.1.1.1", now: NOW, published })).toMatchObject({ ok: false, status: 400 });
  });

  it("counts one back per person per listed suggestion", async () => {
    const s = make();
    expect(await s.back({ issue: 41, ip: "1.1.1.1", now: NOW, published })).toEqual({ ok: true, support: 1, already: false });
    expect(await s.back({ issue: 41, ip: "1.1.1.1", now: NOW, published })).toEqual({ ok: true, support: 1, already: true });
    expect(await s.back({ issue: 41, ip: "2.2.2.2", now: NOW, published })).toEqual({ ok: true, support: 2, already: false });
    expect(await s.back({ issue: 99, ip: "1.1.1.1", now: NOW, published })).toMatchObject({ ok: false, status: 404 });
    expect(await s.supportMap()).toEqual({ "41": 2 });
  });

  it("limits how many suggestions one person can back in a day", async () => {
    const s = make();
    const many: PublishedSuggestion[] = Array.from({ length: 40 }, (_, i) => ({ issue: i + 1, name: `App ${i}`, approved: false, won: false, thumbs: 0, source: "github" }));
    for (let i = 1; i <= LIMITS.backsPerDay; i++) expect((await s.back({ issue: i, ip: "5.5.5.5", now: NOW, published: many })).ok).toBe(true);
    expect(await s.back({ issue: 35, ip: "5.5.5.5", now: NOW, published: many })).toMatchObject({ ok: false, status: 429 });
  });
});

describe("redis client", () => {
  it("sends commands to Upstash and reads hashes", async () => {
    const sent: unknown[] = [];
    const fake = async (_u: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ result: ["a", "1", "b", "2"] });
    };
    const r = new UpstashRedis("https://x.upstash.io/", "t", fake);
    expect(hashToObject(await r.cmd(["HGETALL", "nomad:k"]))).toEqual({ a: "1", b: "2" });
    expect(sent[0]).toEqual(["HGETALL", "nomad:k"]);
    expect(redisFromEnv({})).toBeNull();
    expect(redisFromEnv({ KV_REST_API_URL: "https://x", KV_REST_API_TOKEN: "t" })).toBeInstanceOf(UpstashRedis);
  });
});

class FakeGitHub implements GitHubApi {
  issues: Issue[] = [];
  next = 200;
  async listOpenIssues(label: string) {
    return this.issues.filter((i) => i.state !== "closed" && i.labels.some((l) => l.name === label));
  }
  async listAllIssues(label: string) {
    return this.issues.filter((i) => i.labels.some((l) => l.name === label));
  }
  async createIssue(title: string, body: string, labels: string[]) {
    const number = this.next++;
    this.issues.push({ number, title, body, labels: labels.map((name) => ({ name })), state: "open" });
    return number;
  }
  async comment() {}
  async addLabels() {}
  async removeLabel() {}
  async closeIssue() {}
  async ensureLabel() {}
}

function jobSetup(pending: unknown[] | "down") {
  const repo = mkdtempSync(join(tmpdir(), "nomad-suggest-"));
  const dir = join(repo, "governance");
  mkdirSync(join(dir, "rounds"), { recursive: true });
  cpSync(join(ROOT, "governance", "config.json"), join(dir, "config.json"));
  cpSync(join(ROOT, "governance", "suggestions.json"), join(dir, "suggestions.json"));
  writeFileSync(join(dir, "rounds", "index.json"), JSON.stringify({ latest: 0 }));
  const gh = new FakeGitHub();
  const commits: string[] = [];
  const logs: string[] = [];
  const deps: JobDeps = {
    gh,
    dir,
    now: () => NOW,
    log: (l) => logs.push(l),
    commit: async (m) => {
      commits.push(m);
    },
    fetch: (async (url: string) => {
      if (url.endsWith("/api/suggest/pending")) return pending === "down" ? new Response("x", { status: 503 }) : Response.json({ suggestions: pending });
      return new Response("x", { status: 404 });
    }) as JobDeps["fetch"]
  };
  return { gh, deps, dir, commits, logs };
}

const sug = (id: string, name: string, why = "") => ({ id, name, why, createdAt: NOW.toISOString() });

describe("importing website suggestions", () => {
  it("creates one issue per new suggestion and skips repeats and rejected ones", async () => {
    const t = jobSetup([sug("s1", "Zed", "fast"), sug("s2", "Claude Desktop"), sug("s3", "Kiro"), sug("s4", "zed"), sug("s5", "Amp")]);
    t.gh.issues.push({ number: 10, title: "[Suggestion] Claude Desktop", labels: [{ name: "integration-suggestion" }], state: "open" });
    t.gh.issues.push({ number: 11, title: "[Suggestion] Kiro", body: "<!-- nomad-suggestion: s3 -->", labels: [{ name: "integration-suggestion" }], state: "closed" });
    const cfg = await readConfig(t.dir);
    expect(await importSuggestions(t.deps, cfg)).toBe(2);
    const created = t.gh.issues.filter((i) => i.number >= 200);
    expect(created.map((i) => i.title)).toEqual(["[Suggestion] Zed", "[Suggestion] Amp"]);
    expect(suggestionMarker(created[0].body)).toBe("s1");
    expect(created[0].labels).toEqual([{ name: "integration-suggestion" }]);
    expect(await importSuggestions(t.deps, cfg)).toBe(0);
  });

  it("caps how many issues one run creates", async () => {
    const t = jobSetup(Array.from({ length: 30 }, (_, i) => sug(`s${i}`, `App number ${i}`)));
    expect(await importSuggestions(t.deps, await readConfig(t.dir), 20)).toBe(20);
    expect(await importSuggestions(t.deps, await readConfig(t.dir), 20)).toBe(10);
  });

  it("waits quietly when the website is unreachable", async () => {
    const t = jobSetup("down");
    expect(await importSuggestions(t.deps, await readConfig(t.dir))).toBe(0);
    expect(t.logs.join(" ")).toMatch(/try next run/);
  });

  it("publishes open suggestions and commits only when the list changes", async () => {
    const t = jobSetup([]);
    const cfg = await readConfig(t.dir);
    t.gh.issues.push(
      { number: 12, title: "[Suggestion] Zed", body: "<!-- nomad-suggestion: s1 -->", labels: [{ name: "integration-suggestion" }, { name: "approved" }], reactions: { "+1": 3 }, state: "open" },
      { number: 13, title: "[Suggestion] Spam", labels: [{ name: "integration-suggestion" }], state: "closed" },
      { number: 14, title: "[Suggestion] Amp", labels: [{ name: "integration-suggestion" }, { name: "won" }], state: "open" }
    );
    expect(await publishSuggestions(t.deps, cfg)).toBe(true);
    const file = JSON.parse(readFileSync(join(t.dir, "suggestions.json"), "utf8"));
    expect(file.items).toEqual([
      { issue: 12, name: "Zed", approved: true, won: false, thumbs: 3, source: "site" },
      { issue: 14, name: "Amp", approved: false, won: true, thumbs: 0, source: "github" }
    ]);
    expect(await publishSuggestions(t.deps, cfg)).toBe(false);
    expect(t.commits).toEqual(["chore(vote): update suggestion list"]);
  });

  it("ranks ballots by thumbs-up plus website backing", async () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "governance", "config.json"), "utf8"));
    const a: Issue = { number: 1, title: "A", labels: [], reactions: { "+1": 5 } };
    const b: Issue = { number: 2, title: "B", labels: [], reactions: { "+1": 1 } };
    expect(backing(b, { "2": 9 })).toBe(10);
    expect(pickBallot([a, b], cfg, { "2": 9 }).map((i) => i.number)).toEqual([2, 1]);
    expect(pickBallot([a, b], cfg).map((i) => i.number)).toEqual([1, 2]);
  });
});
