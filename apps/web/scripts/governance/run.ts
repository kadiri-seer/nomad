/**
 * Entry point for the holder-vote workflow (.github/workflows/vote-rounds.yml).
 *   tsx apps/web/scripts/governance/run.ts auto|open|close
 * Needs GITHUB_TOKEN and GITHUB_REPOSITORY, both provided by GitHub Actions.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { closeRound, ensureLabels, githubApi, openRound, readConfig, runAuto, type JobDeps } from "../../lib/vote/job";

const mode = process.argv[2] ?? "auto";
const root = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const dir = resolve(root, "governance");
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !repo) {
  console.error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set.");
  process.exit(1);
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "inherit" });

const deps: JobDeps = {
  gh: githubApi(repo, token),
  fetch,
  now: () => new Date(),
  dir,
  log: (line) => console.log(line),
  async commit(message, files) {
    git("add", "--", ...files);
    git("commit", "-m", message);
    git("push", "origin", "HEAD:main");
  }
};

const cfg = await readConfig(dir);
if (mode === "open") {
  await ensureLabels(deps, cfg);
  console.log(JSON.stringify(await openRound(deps, cfg, { force: true })));
} else if (mode === "close") {
  console.log(JSON.stringify(await closeRound(deps, cfg)));
} else if (mode === "auto") {
  await runAuto(deps, cfg);
} else {
  console.error(`Unknown mode "${mode}". Use auto, open or close.`);
  process.exit(1);
}
