/**
 * Checks a bounty entry's GitHub repo, the way a reviewer would before reading it: it is public, it has a README at its
 * root, and none of its files holds a key, seed phrase or token (Nomad's own secret scanner, the one every migration
 * runs). Reads only public data: GitHub's API for the repo and its file list, and raw file contents. A token in
 * GITHUB_TOKEN (read-only, no scopes) raises GitHub's rate limit; without one the checks still run.
 */
import { scanText } from "@nomad/security";
import { githubRepo, type Check } from "../bounties/shared";

export type RepoResult = { checks: Check[] } | { unavailable: string };

const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|vendor|\.next|coverage|target|__pycache__)\//;
const SKIP_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum)$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|tar|mp4|mov|webm|mp3|wav|woff2?|ttf|otf|eot|wasm|so|dylib|dll|exe|bin|class|jar|pyc|db|sqlite)$/i;
const MAX_FILES = 400;
const MAX_FILE_BYTES = 300_000;
const MAX_TOTAL_BYTES = 5_000_000;

type Tree = { sha: string; truncated?: boolean; tree: { path: string; type: string; size?: number }[] };

export function repoChecker(opts: { fetch?: typeof fetch; token?: string; cache?: { get(k: string): Promise<string | null>; set(k: string, v: string, seconds: number): Promise<void> } } = {}) {
  const get = opts.fetch ?? fetch;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "nomad-bounty-check" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const api = (path: string) => get(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(15_000), cache: "no-store" });

  return async function check(url: string): Promise<RepoResult> {
    const r = githubRepo(url);
    if (!r) return { checks: [{ name: "Public GitHub repo", ok: false, detail: "Give the link to a GitHub repo, like https://github.com/you/your-repo." }] };
    const slug = `${r.owner}/${r.repo}`;
    let info: Response;
    try {
      info = await api(`/repos/${slug}`);
    } catch {
      return { unavailable: "GitHub did not answer" };
    }
    if (info.status === 403 || info.status === 429) return { unavailable: "GitHub is limiting checks right now" };
    if (info.status === 404) return { checks: [{ name: "Public GitHub repo", ok: false, detail: `${slug} was not found. Is it public?` }] };
    if (!info.ok) return { unavailable: `GitHub answered ${info.status}` };
    const repo = (await info.json()) as { private?: boolean; default_branch?: string; full_name?: string };
    if (repo.private) return { checks: [{ name: "Public GitHub repo", ok: false, detail: `${slug} is private.` }] };
    const branch = repo.default_branch ?? "main";

    let tree: Tree;
    try {
      const t = await api(`/repos/${slug}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      if (t.status === 403 || t.status === 429) return { unavailable: "GitHub is limiting checks right now" };
      if (t.status === 404 || t.status === 409) return { checks: [{ name: "Public GitHub repo", ok: true }, { name: "README", ok: false, detail: "The repo is empty." }] };
      if (!t.ok) return { unavailable: `GitHub answered ${t.status}` };
      tree = (await t.json()) as Tree;
    } catch {
      return { unavailable: "GitHub did not answer" };
    }

    const key = `repo-check:${slug.toLowerCase()}@${tree.sha}`;
    const hit = await opts.cache?.get(key).catch(() => null);
    if (hit) return { checks: JSON.parse(hit) as Check[] };

    const blobs = tree.tree.filter((e) => e.type === "blob");
    const readme = blobs.some((e) => /^readme(\.[a-z0-9]+)?$/i.test(e.path));
    const files = blobs.filter((e) => !SKIP_DIRS.test(e.path) && !SKIP_FILES.test(e.path) && !BINARY.test(e.path) && (e.size ?? 0) <= MAX_FILE_BYTES).slice(0, MAX_FILES);
    let total = 0;
    const found: string[] = [];
    let unread = 0;
    const queue = [...files];
    const worker = async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        if (total + (e.size ?? 0) > MAX_TOTAL_BYTES) {
          unread += 1;
          continue;
        }
        total += e.size ?? 0;
        try {
          const raw = await get(`https://raw.githubusercontent.com/${slug}/${encodeURIComponent(branch)}/${e.path.split("/").map(encodeURIComponent).join("/")}`, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
          if (!raw.ok) {
            unread += 1;
            continue;
          }
          for (const f of scanText(await raw.text(), e.path)) found.push(`${f.ruleName} in ${f.file}, line ${f.line}`);
        } catch {
          unread += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (unread > 0 && unread === files.length) return { unavailable: "GitHub did not send the repo's files" };

    const checks: Check[] = [
      { name: "Public GitHub repo", ok: true },
      readme ? { name: "README", ok: true } : { name: "README", ok: false, detail: "Add a README at the top of the repo showing how to run it." },
      found.length
        ? { name: "No secrets committed", ok: false, detail: `Found ${found.slice(0, 3).join("; ")}${found.length > 3 ? ` and ${found.length - 3} more` : ""}. ${found.length > 1 ? "Remove them from the repo and its history, and replace those keys." : "Remove it from the repo and its history, and replace that key."}` }
        : { name: "No secrets committed", ok: true, ...(tree.truncated || unread ? { detail: "The largest files were not all read." } : {}) }
    ];
    await opts.cache?.set(key, JSON.stringify(checks), 6 * 3600).catch(() => undefined);
    return { checks };
  };
}
