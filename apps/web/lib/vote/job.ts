/**
 * The round job, run by GitHub Actions every hour (and by the "Run workflow" button).
 *
 * Opening a round: take the approved suggestions with the most 👍, snapshot $NOMAD balances,
 * publish the ballot and snapshot under governance/rounds/, open a round issue and tell each
 * suggestion it is on the ballot.
 *
 * Closing a round: download every signed vote from the website, check each signature again,
 * recount from the snapshot, publish the votes and the result, and post the outcome on GitHub.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tally, tallyToJson, formatAmount, type Holders, type Round, type RoundResult, type Vote } from "./core";
import { fetchBlockscoutHolders, fetchTransferLogs, holdersFromTransferLogs, rpcCall, sumHolders } from "./snapshot";
import { verifyStoredVote } from "./verify";

export type GovernanceConfig = {
  token: { address: string; symbol: string; decimals: number; deployBlock: number };
  rewardWallet: string;
  excluded: string[];
  chain: { rpc: string; explorer: string };
  site: string;
  votingDays: number;
  cadenceDays: number;
  maxOptions: number;
  minOptions: number;
  labels: { approved: string; suggestion: string; won: string; round: string; bounty: string };
};

export type Issue = { number: number; title: string; labels: { name: string }[]; reactions?: Record<string, number>; pull_request?: unknown; state?: string };

export interface GitHubApi {
  listOpenIssues(label: string): Promise<Issue[]>;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  comment(issue: number, body: string): Promise<void>;
  addLabels(issue: number, labels: string[]): Promise<void>;
  removeLabel(issue: number, label: string): Promise<void>;
  closeIssue(issue: number): Promise<void>;
  ensureLabel(name: string, color: string, description: string): Promise<void>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type JobDeps = {
  gh: GitHubApi;
  fetch: FetchLike;
  now: () => Date;
  /** The governance folder of the repository checkout. */
  dir: string;
  /** Commits and pushes the given files (paths relative to the repository root). */
  commit: (message: string, files: string[]) => Promise<void>;
  log: (line: string) => void;
};

const DAY = 86_400_000;

export async function readConfig(dir: string): Promise<GovernanceConfig> {
  return JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as GovernanceConfig;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

export async function latestRound(dir: string): Promise<Round | null> {
  const index = (await readJsonFile<{ latest: number }>(join(dir, "rounds", "index.json"))) ?? { latest: 0 };
  if (!index.latest) return null;
  return readJsonFile<Round>(join(dir, "rounds", `round-${index.latest}.json`));
}

/** "[Suggestion] Windsurf  editor" becomes "Windsurf editor": short, one line, plain characters. */
export function optionLabel(issue: Pick<Issue, "number" | "title">): string {
  const cleaned = issue.title
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .replace(/[^\p{L}\p{N} .,+&()'/_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned || `Suggestion #${issue.number}`;
}

export function pickBallot(issues: Issue[], cfg: GovernanceConfig): Issue[] {
  return issues
    .filter((i) => !i.pull_request && !i.labels.some((l) => l.name === cfg.labels.won))
    .sort((a, b) => (b.reactions?.["+1"] ?? 0) - (a.reactions?.["+1"] ?? 0) || a.number - b.number)
    .slice(0, cfg.maxOptions);
}

async function snapshotHolders(deps: JobDeps, cfg: GovernanceConfig): Promise<{ holders: Holders; source: string; block: number | null }> {
  let block: number | null = null;
  try {
    block = parseInt(await rpcCall<string>(cfg.chain.rpc, "eth_blockNumber", [], deps.fetch), 16);
  } catch (e) {
    deps.log(`Could not read the latest block: ${(e as Error).message}`);
  }
  try {
    const holders = await fetchBlockscoutHolders(cfg.chain.explorer, cfg.token.address, deps.fetch);
    if (Object.keys(holders).length > 0) return { holders, source: "explorer holder list", block };
    deps.log("The explorer returned no holders; replaying transfers instead.");
  } catch (e) {
    deps.log(`Explorer holder list failed (${(e as Error).message}); replaying transfers instead.`);
  }
  if (block === null) throw new Error("No balance snapshot: the explorer and the RPC both failed. No round was opened.");
  const logs = await fetchTransferLogs(cfg.chain.rpc, cfg.token.address, cfg.token.deployBlock, block, deps.fetch);
  return { holders: holdersFromTransferLogs(logs), source: "token transfer events", block };
}

async function tokenDecimals(deps: JobDeps, cfg: GovernanceConfig): Promise<number> {
  try {
    const hex = await rpcCall<string>(cfg.chain.rpc, "eth_call", [{ to: cfg.token.address, data: "0x313ce567" }, "latest"], deps.fetch);
    const n = parseInt(hex, 16);
    if (Number.isInteger(n) && n >= 0 && n <= 36) return n;
  } catch (e) {
    deps.log(`Could not read token decimals (${(e as Error).message}); using ${cfg.token.decimals} from config.`);
  }
  return cfg.token.decimals;
}

export async function ensureLabels(deps: JobDeps, cfg: GovernanceConfig) {
  const l = cfg.labels;
  await deps.gh.ensureLabel(l.approved, "2E7D4F", "Accepted for the holder vote");
  await deps.gh.ensureLabel(l.suggestion, "C9E265", "Suggested integration");
  await deps.gh.ensureLabel(l.won, "1D5CFF", "Won a holder vote");
  await deps.gh.ensureLabel(l.round, "0B2F8F", "Holder vote round");
  await deps.gh.ensureLabel(l.bounty, "9A620F", "Funded builder bounty");
}

export type OpenOutcome = { opened: number } | { skipped: string };

export async function openRound(deps: JobDeps, cfg: GovernanceConfig, opts: { force: boolean }): Promise<OpenOutcome> {
  const now = deps.now();
  const latest = await latestRound(deps.dir);
  if (latest && !latest.result) {
    return { skipped: now < new Date(latest.closesAt) ? `Round ${latest.id} is still open.` : `Round ${latest.id} has not been closed yet.` };
  }
  if (!opts.force) {
    if (!latest) return { skipped: "The first round opens when you press Run workflow with 'open'." };
    const due = Date.parse(latest.opensAt) + cfg.cadenceDays * DAY;
    if (now.getTime() < due) return { skipped: `The next round is due ${new Date(due).toISOString()}.` };
  }
  const ballot = pickBallot(await deps.gh.listOpenIssues(cfg.labels.approved), cfg);
  if (ballot.length < cfg.minOptions) return { skipped: `Only ${ballot.length} approved suggestion(s); a round needs at least ${cfg.minOptions}.` };

  const id = (latest?.id ?? 0) + 1;
  const { holders, source, block } = await snapshotHolders(deps, cfg);
  const decimals = await tokenDecimals(deps, cfg);
  const excluded = [...new Set([cfg.rewardWallet, ...cfg.excluded].map((a) => a.toLowerCase()))];
  const counted: Holders = Object.fromEntries(Object.entries(holders).filter(([a]) => !excluded.includes(a)));
  const opensAt = now.toISOString();
  const closesAt = new Date(now.getTime() + cfg.votingDays * DAY).toISOString();
  const options = ballot.map((i) => ({ id: String(i.number), label: optionLabel(i), issue: i.number }));
  const voteUrl = `${cfg.site.replace(/\/$/, "")}/vote`;

  const ballotLines = options.map((o) => `- **${o.label}** (#${o.issue})`).join("\n");
  const roundIssue = await deps.gh.createIssue(
    `Round ${id}: next integration`,
    [
      `Holder vote, round ${id}. Vote at ${voteUrl}`,
      ``,
      `**Ballot**`,
      ballotLines,
      ``,
      `- Opens: ${opensAt}`,
      `- Closes: ${closesAt}`,
      `- Voting power: ${cfg.token.symbol} held when the round opened (${Object.keys(counted).length} wallets). One ${cfg.token.symbol} is one vote.`,
      `- Voting is free: your wallet signs a message, nothing is sent on chain. One vote per wallet.`,
      `- Team and reward wallets do not vote.`,
      ``,
      `The ballot and the balance snapshot are published in \`governance/rounds/\`. The result is posted here when the round closes.`
    ].join("\n"),
    [cfg.labels.round]
  );

  const round: Round = {
    id,
    title: `Round ${id}: next integration`,
    opensAt,
    closesAt,
    token: { address: cfg.token.address, symbol: cfg.token.symbol, decimals },
    snapshot: { takenAt: opensAt, source, block, holders: Object.keys(counted).length, totalWeight: sumHolders(counted).toString() },
    options,
    excluded,
    roundIssue,
    result: null
  };
  await writeJson(join(deps.dir, "rounds", `round-${id}-holders.json`), holders);
  await writeJson(join(deps.dir, "rounds", `round-${id}.json`), round);
  await writeJson(join(deps.dir, "rounds", "index.json"), { latest: id });
  await deps.commit(`chore(vote): open round ${id}`, [`governance/rounds/round-${id}.json`, `governance/rounds/round-${id}-holders.json`, "governance/rounds/index.json"]);

  for (const o of options) {
    await deps.gh.comment(o.issue, `This suggestion is on the ballot for Round ${id}, open until ${closesAt}. ${cfg.token.symbol} holders can vote at ${voteUrl} (round page: #${roundIssue}).`);
  }
  deps.log(`Opened round ${id} with ${options.length} options and ${Object.keys(counted).length} holders (${source}).`);
  return { opened: id };
}

export type CloseOutcome = { closed: number; winner: string | null } | { skipped: string };

export async function closeRound(deps: JobDeps, cfg: GovernanceConfig): Promise<CloseOutcome> {
  const now = deps.now();
  const round = await latestRound(deps.dir);
  if (!round) return { skipped: "No rounds yet." };
  if (round.result) return { skipped: `Round ${round.id} is already closed.` };
  if (now < new Date(round.closesAt)) return { skipped: `Round ${round.id} closes ${round.closesAt}.` };

  const holders = (await readJsonFile<Holders>(join(deps.dir, "rounds", `round-${round.id}-holders.json`))) ?? {};
  const res = await deps.fetch(`${cfg.site.replace(/\/$/, "")}/api/vote/votes?round=${round.id}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Could not download votes for round ${round.id} (${res.status}). Will try again next run.`);
  const body = (await res.json()) as { votes?: Vote[] };
  if (!Array.isArray(body.votes)) throw new Error("The vote list from the website is malformed.");

  const valid: Vote[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const v of body.votes) {
    const a = typeof v.address === "string" ? v.address.toLowerCase() : "";
    if (seen.has(a) || !(await verifyStoredVote(round, holders, v))) {
      rejected += 1;
      continue;
    }
    seen.add(a);
    valid.push({ ...v, address: a, weight: holders[a] ?? "0" });
  }
  valid.sort((x, y) => x.votedAt.localeCompare(y.votedAt) || x.address.localeCompare(y.address));
  const t = tallyToJson(tally(round, holders, valid));
  const result: RoundResult = { finalizedAt: now.toISOString(), ...t, rejected };
  await writeJson(join(deps.dir, "rounds", `round-${round.id}-votes.json`), valid);
  await writeJson(join(deps.dir, "rounds", `round-${round.id}.json`), { ...round, result });
  await deps.commit(`chore(vote): close round ${round.id}`, [`governance/rounds/round-${round.id}.json`, `governance/rounds/round-${round.id}-votes.json`]);

  const sym = round.token.symbol;
  const amount = (raw: string) => formatAmount(raw, round.token.decimals, 0);
  const winner = round.options.find((o) => o.id === t.winner) ?? null;
  const table = [
    `| Option | ${sym} | Wallets |`,
    `| --- | ---: | ---: |`,
    ...round.options.map((o) => `| ${o.label} (#${o.issue})${o.id === t.winner ? " **winner**" : ""} | ${amount(t.totals[o.id])} | ${t.voters[o.id]} |`)
  ].join("\n");
  const summary = winner
    ? `**${winner.label}** (#${winner.issue}) won Round ${round.id} with ${amount(t.totals[winner.id])} ${sym} from ${t.voters[winner.id]} wallet(s).`
    : `Round ${round.id} closed with no votes, so there is no winner. Every option stays in the pool.`;
  if (round.roundIssue) {
    await deps.gh.comment(
      round.roundIssue,
      `${summary}\n\n${table}\n\n${t.voterCount} wallet(s) voted. ${rejected ? `${rejected} vote(s) failed the recount and were not counted. ` : ""}Every counted vote, with its signature, is in \`governance/rounds/round-${round.id}-votes.json\`.`
    );
    await deps.gh.closeIssue(round.roundIssue);
  }
  for (const o of round.options) {
    if (winner && o.id === winner.id) {
      await deps.gh.comment(o.issue, `Won Round ${round.id} (#${round.roundIssue}). The builder bounty for it will be posted as a [Bounty] issue.`);
      await deps.gh.addLabels(o.issue, [cfg.labels.won]);
      await deps.gh.removeLabel(o.issue, cfg.labels.approved);
    } else {
      await deps.gh.comment(o.issue, `In Round ${round.id} (#${round.roundIssue}) and did not win${winner ? "" : " (no votes were cast)"}. It stays in the pool for the next round.`);
    }
  }
  deps.log(summary);
  return { closed: round.id, winner: winner?.id ?? null };
}

/** The hourly run: close a finished round, then open the next one when it is due. */
export async function runAuto(deps: JobDeps, cfg: GovernanceConfig) {
  await ensureLabels(deps, cfg);
  const closed = await closeRound(deps, cfg);
  deps.log("skipped" in closed ? `Close: ${closed.skipped}` : `Closed round ${closed.closed}.`);
  const opened = await openRound(deps, cfg, { force: false });
  deps.log("skipped" in opened ? `Open: ${opened.skipped}` : `Opened round ${opened.opened}.`);
}

/** GitHub REST calls with the workflow's own token. Nothing else is needed. */
export function githubApi(repo: string, token: string, fetchImpl: FetchLike = fetch): GitHubApi {
  const base = `https://api.github.com/repos/${repo}`;
  async function call(method: string, path: string, body?: unknown, allow: number[] = []) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok && !allow.includes(res.status)) throw new Error(`GitHub ${method} ${path} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }
  return {
    async listOpenIssues(label) {
      const out: Issue[] = [];
      for (let page = 1; page <= 20; page++) {
        const batch = (await call("GET", `/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`)) as Issue[];
        out.push(...batch);
        if (batch.length < 100) break;
      }
      return out;
    },
    async createIssue(title, body, labels) {
      return ((await call("POST", "/issues", { title, body, labels })) as { number: number }).number;
    },
    async comment(issue, body) {
      await call("POST", `/issues/${issue}/comments`, { body });
    },
    async addLabels(issue, labels) {
      await call("POST", `/issues/${issue}/labels`, { labels });
    },
    async removeLabel(issue, label) {
      await call("DELETE", `/issues/${issue}/labels/${encodeURIComponent(label)}`, undefined, [404]);
    },
    async closeIssue(issue) {
      await call("PATCH", `/issues/${issue}`, { state: "closed" });
    },
    async ensureLabel(name, color, description) {
      await call("POST", "/labels", { name, color, description }, [422]);
    }
  };
}
