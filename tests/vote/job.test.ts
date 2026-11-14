import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { closeRound, githubApi, openRound, optionLabel, pickBallot, readConfig, runAuto, type GitHubApi, type Issue, type JobDeps } from "../../apps/web/lib/vote/job";
import { voteMessage, type Round } from "../../apps/web/lib/vote/core";
import { TRANSFER_TOPIC } from "../../apps/web/lib/vote/snapshot";

const ROOT = resolve(__dirname, "../..");
const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const bob = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const SAFE = "0xe4862B7605f0CD66796F5d1A9cC936462642b515";
const E18 = 10n ** 18n;
const DAY = 86_400_000;

class FakeGitHub implements GitHubApi {
  issues: Issue[] = [];
  created: { number: number; title: string; body: string; labels: string[] }[] = [];
  comments: { issue: number; body: string }[] = [];
  closed: number[] = [];
  labelsEnsured: string[] = [];
  next = 100;
  async listOpenIssues(label: string) {
    return this.issues.filter((i) => i.state !== "closed" && i.labels.some((l) => l.name === label));
  }
  async listAllIssues(label: string) {
    return this.issues.filter((i) => i.labels.some((l) => l.name === label));
  }
  async createIssue(title: string, body: string, labels: string[]) {
    const number = this.next++;
    this.created.push({ number, title, body, labels });
    this.issues.push({ number, title, body, labels: labels.map((name) => ({ name })) });
    return number;
  }
  async comment(issue: number, body: string) {
    this.comments.push({ issue, body });
  }
  async addLabels(issue: number, labels: string[]) {
    const i = this.issues.find((x) => x.number === issue)!;
    for (const name of labels) if (!i.labels.some((l) => l.name === name)) i.labels.push({ name });
  }
  async removeLabel(issue: number, label: string) {
    const i = this.issues.find((x) => x.number === issue)!;
    i.labels = i.labels.filter((l) => l.name !== label);
  }
  async closeIssue(issue: number) {
    this.closed.push(issue);
    const i = this.issues.find((x) => x.number === issue);
    if (i) i.state = "closed";
  }
  async ensureLabel(name: string) {
    this.labelsEnsured.push(name);
  }
}

const suggestion = (number: number, title: string, up: number, extra: string[] = []): Issue => ({
  number,
  title,
  labels: [{ name: "integration-suggestion" }, { name: "approved" }, ...extra.map((name) => ({ name }))],
  reactions: { "+1": up }
});

type World = { explorerDown?: boolean; rpcDown?: boolean; votes?: unknown[] };

function setup(world: World = {}) {
  const repo = mkdtempSync(join(tmpdir(), "nomad-vote-job-"));
  const dir = join(repo, "governance");
  mkdirSync(join(dir, "rounds"), { recursive: true });
  cpSync(join(ROOT, "governance", "config.json"), join(dir, "config.json"));
  cpSync(join(ROOT, "governance", "suggestions.json"), join(dir, "suggestions.json"));
  writeFileSync(join(dir, "rounds", "index.json"), JSON.stringify({ latest: 0 }));
  const gh = new FakeGitHub();
  let now = new Date("2026-12-01T10:00:00Z");
  const commits: { message: string; files: string[] }[] = [];
  const logs: string[] = [];
  const holderItems = [
    { address: { hash: alice.address }, value: (1000n * E18).toString() },
    { address: { hash: bob.address }, value: (250n * E18).toString() },
    { address: { hash: SAFE }, value: (5000n * E18).toString() }
  ];
  const pad = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  const fetchFake = async (url: string, init?: RequestInit) => {
    if (url.includes("/api/v2/tokens/")) {
      if (world.explorerDown) return new Response("down", { status: 503 });
      return Response.json({ items: holderItems, next_page_params: null });
    }
    if (url.includes("/api/vote/votes")) return Response.json({ votes: world.votes ?? [] });
    if (init?.method === "POST") {
      if (world.rpcDown) return new Response("down", { status: 503 });
      const { method } = JSON.parse(String(init.body));
      if (method === "eth_blockNumber") return Response.json({ result: "0x64" });
      if (method === "eth_call") return Response.json({ result: "0x12" });
      if (method === "eth_getLogs")
        return Response.json({
          result: [
            { topics: [TRANSFER_TOPIC, pad("0x0000000000000000000000000000000000000000"), pad(alice.address)], data: "0x" + (700n * E18).toString(16) },
            { topics: [TRANSFER_TOPIC, pad(alice.address), pad(bob.address)], data: "0x" + (100n * E18).toString(16) }
          ]
        });
    }
    return new Response("not found", { status: 404 });
  };
  const deps: JobDeps = {
    gh,
    fetch: fetchFake as JobDeps["fetch"],
    now: () => now,
    dir,
    log: (l) => logs.push(l),
    async commit(message, files) {
      for (const f of files) expect(existsSync(join(repo, f))).toBe(true);
      commits.push({ message, files });
    }
  };
  return {
    repo,
    dir,
    gh,
    deps,
    commits,
    logs,
    world,
    setNow: (d: Date) => (now = d),
    read: <T>(name: string) => JSON.parse(readFileSync(join(dir, "rounds", name), "utf8")) as T
  };
}

async function signedVote(account: typeof alice, round: Round, choice: string, votedAt: string) {
  const option = round.options.find((o) => o.id === choice)!;
  const address = account.address.toLowerCase();
  return { round: round.id, address, choice, signature: await account.signMessage({ message: voteMessage(round, option, address) }), weight: "999", votedAt };
}

describe("round job", () => {
  it("waits for the button before the first round", async () => {
    const t = setup();
    const cfg = await readConfig(t.dir);
    t.gh.issues = [suggestion(12, "[Suggestion] Windsurf", 3), suggestion(15, "[Suggestion] Cline", 1)];
    await runAuto(t.deps, cfg);
    expect(t.commits.map((c) => c.message)).toEqual(["chore(vote): update suggestion list"]);
    expect(t.logs.join("\n")).toMatch(/first round opens/);
    expect(t.gh.labelsEnsured).toEqual(expect.arrayContaining(["approved", "won", "round", "bounty", "integration-suggestion"]));
  });

  it("needs at least two approved suggestions", async () => {
    const t = setup();
    t.gh.issues = [suggestion(12, "Windsurf", 3)];
    expect(await openRound(t.deps, await readConfig(t.dir), { force: true })).toMatchObject({ skipped: expect.stringMatching(/at least 2/) });
  });

  it("opens a round from the most liked approved suggestions with a published snapshot", async () => {
    const t = setup();
    const cfg = await readConfig(t.dir);
    t.gh.issues = [
      suggestion(12, "[Suggestion] Windsurf", 3),
      suggestion(15, "[Suggestion] Cline", 7),
      suggestion(18, "[Suggestion] Zed", 0),
      suggestion(20, "[Suggestion] Old winner", 50, ["won"]),
      { ...suggestion(21, "A pull request", 99), pull_request: {} }
    ];
    expect(await openRound(t.deps, cfg, { force: true })).toEqual({ opened: 1 });
    const round = t.read<Round>("round-1.json");
    expect(round.options.map((o) => o.label)).toEqual(["Cline", "Windsurf", "Zed"]);
    expect(round.excluded).toContain(SAFE.toLowerCase());
    expect(round.snapshot).toMatchObject({ holders: 2, totalWeight: (1250n * E18).toString(), source: "explorer holder list", block: 100 });
    expect(round.token.decimals).toBe(18);
    expect(Date.parse(round.closesAt) - Date.parse(round.opensAt)).toBe(2 * DAY);
    expect(t.read<Record<string, string>>("round-1-holders.json")[alice.address.toLowerCase()]).toBe((1000n * E18).toString());
    expect(t.read<{ latest: number }>("index.json")).toEqual({ latest: 1 });
    expect(t.commits[0].message).toBe("chore(vote): open round 1");
    expect(t.gh.created[0]).toMatchObject({ title: "Round 1: next integration", labels: ["round"] });
    expect(t.gh.created[0].body).toContain("https://nomad-iota-six.vercel.app/vote");
    expect(round.roundIssue).toBe(t.gh.created[0].number);
    expect(t.gh.comments.map((c) => c.issue).sort()).toEqual([12, 15, 18]);
    expect(await openRound(t.deps, cfg, { force: true })).toMatchObject({ skipped: "Round 1 is still open." });
  });

  it("falls back to replaying transfers when the explorer is down", async () => {
    const t = setup({ explorerDown: true });
    t.gh.issues = [suggestion(12, "Windsurf", 3), suggestion(15, "Cline", 1)];
    await openRound(t.deps, await readConfig(t.dir), { force: true });
    const round = t.read<Round>("round-1.json");
    expect(round.snapshot.source).toBe("token transfer events");
    expect(t.read<Record<string, string>>("round-1-holders.json")).toEqual({ [alice.address.toLowerCase()]: (600n * E18).toString(), [bob.address.toLowerCase()]: (100n * E18).toString() });
  });

  it("opens nothing when no snapshot can be taken", async () => {
    const t = setup({ explorerDown: true, rpcDown: true });
    t.gh.issues = [suggestion(12, "Windsurf", 3), suggestion(15, "Cline", 1)];
    await expect(openRound(t.deps, await readConfig(t.dir), { force: true })).rejects.toThrow(/No round was opened/);
    expect(t.gh.created).toHaveLength(0);
    expect(t.commits).toHaveLength(0);
    expect(existsSync(join(t.dir, "rounds", "round-1.json"))).toBe(false);
  });

  it("recounts every vote at close, rejecting forged, late, duplicate and excluded ones", async () => {
    const t = setup();
    const cfg = await readConfig(t.dir);
    t.gh.issues = [suggestion(12, "Windsurf", 3), suggestion(15, "Cline", 1), suggestion(18, "Zed", 0)];
    await openRound(t.deps, cfg, { force: true });
    const round = t.read<Round>("round-1.json");
    expect(await closeRound(t.deps, cfg)).toMatchObject({ skipped: expect.stringMatching(/closes/) });

    const during = new Date(Date.parse(round.opensAt) + DAY).toISOString();
    const late = new Date(Date.parse(round.closesAt) + 1000).toISOString();
    const a = await signedVote(alice, round, "15", during);
    const b = await signedVote(bob, round, "12", during);
    const forged = { ...(await signedVote(bob, round, "18", during)), address: alice.address.toLowerCase() };
    const duplicate = await signedVote(alice, round, "12", during);
    const lateVote = { ...b, votedAt: late };
    const safe = { round: 1, address: SAFE.toLowerCase(), choice: "12", signature: "0x" + "ab".repeat(65), weight: "1", votedAt: during };
    t.world.votes = [a, b, forged, duplicate, lateVote, safe];

    t.setNow(new Date(Date.parse(round.closesAt) + 60_000));
    expect(await closeRound(t.deps, cfg)).toEqual({ closed: 1, winner: "15" });
    const done = t.read<Round>("round-1.json");
    expect(done.result).toMatchObject({ winner: "15", voterCount: 2, rejected: 4, totalWeight: (1250n * E18).toString() });
    expect(done.result?.totals).toEqual({ "15": (1000n * E18).toString(), "12": (250n * E18).toString(), "18": "0" });
    const archived = t.read<{ address: string; weight: string }[]>("round-1-votes.json");
    expect(archived.map((v) => v.address).sort()).toEqual([alice.address.toLowerCase(), bob.address.toLowerCase()].sort());
    expect(archived.find((v) => v.address === alice.address.toLowerCase())?.weight).toBe((1000n * E18).toString());
    expect(t.commits.at(-1)?.message).toBe("chore(vote): close round 1");

    const winnerIssue = t.gh.issues.find((i) => i.number === 15)!;
    expect(winnerIssue.labels.map((l) => l.name)).toContain("won");
    expect(winnerIssue.labels.map((l) => l.name)).not.toContain("approved");
    expect(t.gh.closed).toContain(round.roundIssue);
    const roundComment = t.gh.comments.find((c) => c.issue === round.roundIssue)!.body;
    expect(roundComment).toContain("**Cline** (#15) won Round 1 with 1,000 $NOMAD from 1 wallet(s).");
    expect(roundComment).toContain("4 vote(s) failed the recount");
    expect(t.gh.comments.some((c) => c.issue === 12 && /did not win/.test(c.body))).toBe(true);
    expect(await closeRound(t.deps, cfg)).toMatchObject({ skipped: "Round 1 is already closed." });
  });

  it("declares no winner when nobody voted, and opens the next round on schedule without past winners", async () => {
    const t = setup();
    const cfg = await readConfig(t.dir);
    t.gh.issues = [suggestion(12, "Windsurf", 3), suggestion(15, "Cline", 1), suggestion(18, "Zed", 0)];
    await openRound(t.deps, cfg, { force: true });
    const r1 = t.read<Round>("round-1.json");
    t.world.votes = [];
    t.setNow(new Date(Date.parse(r1.closesAt) + 1));
    expect(await closeRound(t.deps, cfg)).toEqual({ closed: 1, winner: null });
    expect(t.gh.comments.find((c) => c.issue === r1.roundIssue)?.body).toMatch(/no votes, so there is no winner/);

    await t.gh.addLabels(12, ["won"]);
    t.setNow(new Date(Date.parse(r1.opensAt) + 6 * DAY));
    await runAuto(t.deps, cfg);
    expect(t.read<{ latest: number }>("index.json")).toEqual({ latest: 1 });
    t.setNow(new Date(Date.parse(r1.opensAt) + 7 * DAY + 1));
    await runAuto(t.deps, cfg);
    const r2 = t.read<Round>("round-2.json");
    expect(r2.options.map((o) => o.id)).toEqual(["15", "18"]);
  });

  it("cleans suggestion titles into ballot labels", () => {
    expect(optionLabel({ number: 3, title: "[Suggestion]   Windsurf\n editor <script>" })).toBe("Windsurf editor script");
    expect(optionLabel({ number: 4, title: "[Suggestion] " })).toBe("Suggestion #4");
    expect(optionLabel({ number: 5, title: "x".repeat(90) })).toHaveLength(60);
  });

  it("picks at most five, most liked first", async () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "governance", "config.json"), "utf8"));
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) => suggestion(n, `S${n}`, n % 3));
    expect(pickBallot(many, cfg).map((i) => i.number)).toEqual([2, 5, 1, 4, 7]);
  });
});

describe("GitHub client", () => {
  it("pages through issues and tolerates existing labels and missing labels", async () => {
    const calls: string[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url.replace("https://api.github.com/repos/o/r", "")}`);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      if (url.includes("/issues?") && url.endsWith("&page=1")) return Response.json(Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: "x", labels: [] })));
      if (url.includes("/issues?") && url.endsWith("&page=2")) return Response.json([{ number: 101, title: "y", labels: [] }]);
      if (url.endsWith("/labels") && init?.method === "POST") return new Response("{}", { status: 422 });
      if (init?.method === "DELETE") return new Response("{}", { status: 404 });
      if (url.endsWith("/issues") && init?.method === "POST") return Response.json({ number: 7 }, { status: 201 });
      if (init?.method === "PATCH") return new Response("{}", { status: 500 });
      return Response.json({});
    };
    const gh = githubApi("o/r", "tok", fake as typeof fetch);
    expect(await gh.listOpenIssues("approved")).toHaveLength(101);
    await gh.ensureLabel("won", "fff", "d");
    await gh.removeLabel(3, "approved");
    expect(await gh.createIssue("t", "b", ["round"])).toBe(7);
    await expect(gh.closeIssue(7)).rejects.toThrow(/500/);
    expect(calls[0]).toBe("GET /issues?state=open&labels=approved&per_page=100&page=1");
  });
});
