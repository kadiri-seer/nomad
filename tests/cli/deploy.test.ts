import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_DEPLOY_INSTRUCTIONS, uploadDraft, type DeployDraft } from "../../apps/cli/src/deploy";
import { checkDraft, draftStore } from "../../apps/web/lib/server/agent-drafts";
import { MemoryRedis } from "../../apps/web/lib/redis";
import { buildClaudeCodeStoa } from "../fixtures/stoa";
import { setup, type Env } from "../helpers";

const CLI = resolve(__dirname, "../../apps/cli/src/index.ts");
const TSX_CLI = resolve(__dirname, "../../node_modules/tsx/dist/cli.mjs");

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => env.cleanup());

function nomad(...args: string[]) {
  const r = spawnSync(process.execPath, [TSX_CLI, CLI, "--json", ...args], { env: { ...process.env, NOMAD_FAKE_HOME: env.home, NOMAD_HOME: env.nomadHome }, encoding: "utf8", timeout: 60000 });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not json */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const draft = (over: Partial<DeployDraft> = {}): DeployDraft => ({ v: 1, name: "Scout", template: "researcher", instructions: "Watch new launches.", trimmed: false, from: "Claude Code", cloud: [], local: [], ...over });

describe("nomad deploy", () => {
  it("prepares a draft from a Claude Code agent: its instructions and skills, Stoa kept in the cloud, set up to trade", () => {
    const dir = buildClaudeCodeStoa(join(env.home, "stoa-home"));
    const r = nomad("deploy", `claude-code:${dir}`, "--dry-run");
    expect(r.code, r.stderr).toBe(0);
    const d = r.json.draft as DeployDraft;
    expect(d.v).toBe(1);
    expect(d.from).toBe("Claude Code");
    expect(d.instructions).toContain("Run Stoa's safety check before buying an unfamiliar token.");
    expect(d.instructions).toContain("## Skills it had in Claude Code");
    expect(d.instructions).toMatch(/- stoa: Quote, check and build token swaps/);
    expect(d.cloud).toEqual(["Stoa"]);
    expect(d.template).toBe("blank");
  });

  it("never sends a secret, and keeps tools it cannot run in the cloud on this computer", () => {
    const root = join(env.home, "proj/.claude");
    mkdirSync(root, { recursive: true });
    const key = "sk-ant-api03-" + "Q".repeat(90);
    writeFileSync(join(root, "CLAUDE.md"), `# Notes\n\nSummarize the week's research.\nMy key is ${key}\n`);
    writeFileSync(join(env.home, "proj/.mcp.json"), JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "some-local-server"] } } }));
    const r = nomad("deploy", `claude-code:${root}`, "--dry-run");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain(key);
    const d = r.json.draft as DeployDraft;
    expect(d.instructions).toContain("Summarize the week's research.");
    expect(d.template).toBe("researcher");
    expect(d.cloud).toEqual([]);
  });

  it("shortens very long instructions to what an agent on Nomad keeps", () => {
    const root = join(env.home, "long/.claude");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), Array.from({ length: 200 }, (_, i) => `Rule ${i}: check the token twice before you trade it.`).join("\n\n"));
    const d = nomad("deploy", `claude-code:${root}`, "--dry-run").json.draft as DeployDraft;
    expect(d.trimmed).toBe(true);
    expect(d.instructions.length).toBeLessThanOrEqual(MAX_DEPLOY_INSTRUCTIONS);
    expect(d.instructions.endsWith("trade it.")).toBe(true);
  });

  it("sends the draft to Nomad and returns the link to finish on the account page", async () => {
    let sent: { url: string; body: unknown } | null = null;
    const fetchImpl = (async (url: string, init: { body: string }) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ id: "abcdefghijklmnopqrstuvwx" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await uploadDraft(draft(), "https://example.test", fetchImpl);
    expect(sent).toMatchObject({ url: "https://example.test/api/agents/draft", body: { name: "Scout" } });
    expect(r.url).toBe("https://example.test/account?deploy=abcdefghijklmnopqrstuvwx");
    const refused = (async () => new Response(JSON.stringify({ error: "The agent has no name." }), { status: 400 })) as unknown as typeof fetch;
    await expect(uploadDraft(draft(), "https://example.test", refused)).rejects.toThrow("The agent has no name.");
  });
});

describe("drafts on Nomad", () => {
  const clean = async () => 0;

  it("keeps a clean draft for 24 hours under an unguessable id", async () => {
    const redis = new MemoryRedis();
    const store = draftStore(redis);
    const d = await checkDraft({ ...draft(), cloud: ["Stoa", 5], template: "trader" }, clean, 1000);
    expect(d).toMatchObject({ name: "Scout", template: "researcher", cloud: ["Stoa"], at: 1000 });
    const id = await store.put(d);
    expect(id).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await store.get(id)).toEqual(d);
    expect(await store.get("../../etc")).toBeNull();
    expect(await store.get("x".repeat(24))).toBeNull();
  });

  it("refuses a draft with a secret, planted orders, no name, or from an old version", async () => {
    await expect(checkDraft({ ...draft(), instructions: `use sk-ant-api03-${"Q".repeat(90)}` }, clean)).rejects.toMatchObject({ status: 400 });
    await expect(checkDraft(draft() as unknown as Record<string, unknown>, async () => 1)).rejects.toThrow(/planted orders/);
    await expect(checkDraft({ ...draft(), name: "  " }, clean)).rejects.toThrow(/no name/);
    await expect(checkDraft({ ...draft(), v: 2 }, clean)).rejects.toThrow(/Update Nomad/);
    await expect(checkDraft({ ...draft(), instructions: "x".repeat(4001) }, clean)).rejects.toThrow(/4,000/);
  });
});
