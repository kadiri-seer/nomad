import { describe, expect, it } from "vitest";
import { repoChecker } from "../../apps/web/lib/server/repo-check";
import { githubRepo } from "../../apps/web/lib/bounties/shared";

type Files = Record<string, string>;
/** A fake GitHub: one repo with these files, public unless said otherwise. */
function github(files: Files, o: { private?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (o.status) return new Response("", { status: o.status });
    if (url === "https://api.github.com/repos/me/kit") return json({ private: !!o.private, default_branch: "main" });
    if (url === "https://api.github.com/repos/me/kit/git/trees/main?recursive=1")
      return json({ sha: "abc", tree: Object.entries(files).map(([path, text]) => ({ path, type: "blob", size: text.length })) });
    const raw = url.replace("https://raw.githubusercontent.com/me/kit/main/", "");
    return raw in files ? new Response(files[raw]) : new Response("", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}
const KEY = `0x${"ab".repeat(32)}`;

describe("repo check", () => {
  it("reads GitHub links and nothing else", () => {
    expect(githubRepo("https://github.com/me/kit")).toEqual({ owner: "me", repo: "kit" });
    expect(githubRepo("https://github.com/me/kit.git/")).toEqual({ owner: "me", repo: "kit" });
    expect(githubRepo("https://gitlab.com/me/kit")).toBeNull();
    expect(githubRepo("https://github.com/me/kit/tree/main")).toBeNull();
  });

  it("passes a public repo with a README and no secrets, and reads each version once", async () => {
    const { f, calls } = github({ "README.md": "# Kit\nRun: node pay.mjs", "pay.mjs": "const key = process.env.AGENT_KEY;", "logo.png": "binary" });
    const store = new Map<string, string>();
    const check = repoChecker({ fetch: f, cache: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) } });
    expect(await check("https://github.com/me/kit")).toEqual({ checks: [{ name: "Public GitHub repo", ok: true }, { name: "README", ok: true }, { name: "No secrets committed", ok: true }] });
    expect(calls.some((c) => c.endsWith("logo.png"))).toBe(false);
    const before = calls.length;
    await check("https://github.com/me/kit");
    // Same version: only the repo and its file list are asked again.
    expect(calls.length - before).toBe(2);
  });

  it("names the file and line of a committed key, and asks for a README", async () => {
    const { f } = github({ "src/.env": `RPC=https://rpc\nPRIVATE_KEY=${KEY}\n`, "index.js": "x" });
    const r = await repoChecker({ fetch: f })("https://github.com/me/kit");
    expect(r).toMatchObject({ checks: [{ ok: true }, { name: "README", ok: false }, { name: "No secrets committed", ok: false, detail: /Wallet private key in src\/\.env, line 2/ }] });
    expect(JSON.stringify(r)).not.toContain("abab");
  });

  it("a private or missing repo fails; GitHub limits or errors say the check could not run", async () => {
    expect(await repoChecker({ fetch: github({}, { private: true }).f })("https://github.com/me/kit")).toMatchObject({ checks: [{ ok: false, detail: /private/ }] });
    expect(await repoChecker({ fetch: github({}, { status: 404 }).f })("https://github.com/me/kit")).toMatchObject({ checks: [{ ok: false, detail: /not found/ }] });
    expect(await repoChecker({ fetch: github({}, { status: 403 }).f })("https://github.com/me/kit")).toEqual({ unavailable: "GitHub is limiting checks right now" });
    expect(await repoChecker({ fetch: github({}).f })("not a link")).toMatchObject({ checks: [{ ok: false, detail: /GitHub repo/ }] });
  });
});
