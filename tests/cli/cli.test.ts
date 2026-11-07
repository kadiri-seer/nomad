import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "@nomad/mcp";
import { setup, type Env } from "../helpers";

const CLI = resolve(__dirname, "../../apps/cli/src/index.ts");
const TSX = resolve(__dirname, "../../node_modules/.bin/tsx");

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => env.cleanup());

function nomad(...args: string[]) {
  const r = spawnSync(TSX, [CLI, "--json", ...args], { env: { ...process.env, NOMAD_FAKE_HOME: env.home, NOMAD_HOME: env.nomadHome }, encoding: "utf8", timeout: 60000 });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not json */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

describe("CLI", () => {
  it("scans, migrates with --yes, exports, validates and lists history", () => {
    const scan = nomad("scan");
    expect(scan.code).toBe(0);
    expect(scan.json.map((p: any) => p.adapter).sort()).toEqual(["claude-code", "codex", "hermes", "openclaw"]);

    const dest = join(env.home, "proj/.claude");
    mkdirSync(dest, { recursive: true });
    const dry = nomad("migrate", "--from", "openclaw", "--to", "claude-code", "--dest-dir", dest, "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.json.plan.summary.create).toBeGreaterThan(0);
    expect(existsSync(join(dest, "CLAUDE.md"))).toBe(false);

    const noYes = nomad("migrate", "--from", "openclaw", "--to", "claude-code", "--dest-dir", dest);
    expect(noYes.code).toBe(3); // non-interactive without --yes is refused
    expect(existsSync(join(dest, "CLAUDE.md"))).toBe(false);

    const run = nomad("migrate", "--from", "openclaw", "--to", "claude-code", "--dest-dir", dest, "--yes");
    expect(run.code).toBe(0);
    expect(run.json.receipt.status).toBe("success");

    const out = join(env.home, "k.nomad");
    expect(nomad("export", "Kestrel", "-o", out).code).toBe(0);
    const v = nomad("validate", out);
    expect(v.code).toBe(0);
    expect(v.json.ok).toBe(true);
    const hist = nomad("history");
    expect(hist.json.map((h: any) => h.kind)).toEqual(["export", "migrate"]);
  });

  it("returns the approval exit code when replace needs approval", () => {
    const r = nomad("migrate", "--from", "hermes", "--to", "openclaw", "--mode", "replace", "--yes");
    expect(r.code).toBe(3);
    expect(r.json.code).toBe("approval-required");
  });

  it("rejects an invalid package with exit code 4", () => {
    const bad = join(env.home, "bad.agentpack");
    require("node:fs").writeFileSync(bad, "nope");
    expect(nomad("validate", bad).code).toBe(4);
  });

  it("moves in one line to a platform and to a signed file", () => {
    const preview = nomad("move", "openclaw", "codex", "--dry-run");
    expect(preview.code).toBe(0);
    expect(preview.json.plan.summary.create + preview.json.plan.summary.update).toBeGreaterThan(0);
    const moved = nomad("move", "openclaw", "codex", "--yes");
    expect(moved.code).toBe(0);
    expect(moved.json.receipt.status).toBe("success");
    expect(readFileSync(join(env.home, ".codex/AGENTS.md"), "utf8")).toContain("nomad:begin");

    const file = join(env.home, "out/kestrel.nomad");
    const saved = nomad("move", "openclaw", file, "--sign");
    expect(saved.code).toBe(0);
    expect(saved.json.signedBy).toMatch(/^[0-9a-f]{4} /);
    const v = nomad("validate", file);
    expect(v.json.signer.state).toBe("you");
    const keys = nomad("keys");
    expect(keys.json.key.fingerprint).toBe(saved.json.signedBy);

    // someone else opens it: unknown until trusted
    const other = join(env.home, "other");
    const asOther = (...args: string[]) => nomad("--home", other, ...args);
    expect(asOther("validate", file).json.signer.state).toBe("unknown");
    expect(asOther("trust", file, "--name", "Ada").code).toBe(0);
    expect(asOther("validate", file).json.signer).toMatchObject({ state: "trusted", name: "Ada" });
    const back = asOther("move", file, `claude-code:${join(env.home, "proj2/.claude")}`, "--yes");
    expect(back.code).toBe(0);
    expect(existsSync(join(env.home, "proj2/.claude/CLAUDE.md"))).toBe(true);
  });

  it("explains a destination it does not understand", () => {
    const r = nomad("move", "openclaw", "somewhere-else");
    expect(r.code).toBe(2);
    expect(r.json.hint).toMatch(/\.nomad/);
  });

  it("prints help instead of prompting when not in a terminal", () => {
    const r = spawnSync(TSX, [CLI], { env: { ...process.env, NOMAD_FAKE_HOME: env.home, NOMAD_HOME: env.nomadHome }, encoding: "utf8", timeout: 60000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Start here");
  });

  it("explains unknown sources", () => {
    const r = nomad("inspect", "nonsense-thing");
    expect(r.code).toBe(2);
    expect(r.json.hint).toContain("package path");
  });
});

describe("MCP server", () => {
  async function connect(opts: { allowWrites?: boolean; allowReplace?: boolean }) {
    const { server, nomad } = createMcpServer({ home: env.nomadHome, ...opts });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, nomad };
  }
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { error: !!r.isError, text: r.content[0].text as string, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() };
  };

  it("lists tools and previews without writing", async () => {
    const { client, nomad } = await connect({});
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["list_agents", "inspect_agent", "preview_migration", "execute_migration", "export_agent"]));
    const insp = await call(client, "inspect_agent", { source: "openclaw" });
    expect(insp.json.name).toBe("Kestrel");
    const dest = join(env.home, "m/.claude");
    const prev = await call(client, "preview_migration", { source: "openclaw", platform: "claude-code", destDir: dest });
    expect(prev.json.planId).toMatch(/^plan_/);
    const exec = await call(client, "execute_migration", { planId: prev.json.planId, approvalToken: prev.json.approvalToken });
    expect(exec.error).toBe(true);
    expect(exec.text).toContain("read only");
    expect(existsSync(join(dest, "CLAUDE.md"))).toBe(false);
    const rep = await call(client, "preview_migration", { source: "openclaw", platform: "claude-code", destDir: dest, mode: "replace" });
    expect(rep.error).toBe(true);
    nomad.close();
  });

  it("executes only with write access and the preview token", async () => {
    const { client, nomad } = await connect({ allowWrites: true });
    const dest = join(env.home, "w/.claude");
    const prev = await call(client, "preview_migration", { source: "openclaw", platform: "claude-code", destDir: dest });
    const wrong = await call(client, "execute_migration", { planId: prev.json.planId, approvalToken: "nope" });
    expect(wrong.error).toBe(true);
    const ok = await call(client, "execute_migration", { planId: prev.json.planId, approvalToken: prev.json.approvalToken });
    expect(ok.json.status).toBe("success");
    // Approvals an assistant cannot give: broader permissions
    const prev2 = await call(client, "preview_migration", { source: "hermes", platform: "claude-code", destDir: join(env.home, "w2/.claude") });
    expect(prev2.json.approvalsRequired).toContain("broader-permissions");
    const denied = await call(client, "execute_migration", { planId: prev2.json.planId, approvalToken: prev2.json.approvalToken });
    expect(denied.error).toBe(true);
    nomad.close();
  });
});
