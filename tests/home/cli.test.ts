import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setup, type Env } from "../helpers";

const CLI = resolve(__dirname, "../../apps/cli/src/index.ts");
const TSX_CLI = resolve(__dirname, "../../node_modules/tsx/dist/cli.mjs");

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => env.cleanup());

function nomad(args: string[], json = true) {
  const r = spawnSync(process.execPath, [TSX_CLI, CLI, ...(json ? ["--json"] : []), ...args], { env: { ...process.env, NOMAD_FAKE_HOME: env.home, NOMAD_HOME: env.nomadHome }, encoding: "utf8", timeout: 60000 });
  let out: any = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    /* not json */
  }
  return { code: r.status, json: out, stdout: r.stdout, stderr: r.stderr };
}

describe("CLI: nomad home and nomad connect", () => {
  it("lists, gathers, borrows, sends back and brings", () => {
    const first = nomad(["home"]);
    expect(first.code).toBe(0);
    expect(first.json.agents).toEqual([]);
    expect(first.json.notInHomeYet.length).toBeGreaterThan(0);
    expect(nomad(["home", "gather"]).code).toBe(0);
    expect(nomad(["home"]).json.agents.map((a: any) => a.name)).toContain("Kestrel");

    const b = nomad(["home", "borrow", "Kestrel"], false);
    expect(b.code).toBe(0);
    expect(b.stdout).toContain("# Borrowed agent: Kestrel");

    const refused = nomad(["home", "send-back", "Kestrel", "--note", "Ada is learning Yoruba."]);
    expect(refused.code).toBe(3); // not interactive and no --yes
    const saved = nomad(["home", "send-back", "Kestrel", "--note", "Ada is learning Yoruba.", "--yes"]);
    expect(saved.code).toBe(0);
    expect(saved.json.receipt.added).toBe(1);
    expect(saved.json.receipt.behind.map((c: any) => c.adapter)).toEqual(["openclaw"]);

    const dest = join(env.home, "proj");
    mkdirSync(dest, { recursive: true });
    const brought = nomad(["home", "bring", "Kestrel", `claude-code:${dest}`, "--yes"]);
    expect(brought.code).toBe(0);
    const files = readdirSync(dest, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
    expect(files.some((f) => readFileSync(join(f.parentPath, f.name), "utf8").includes("Ada is learning Yoruba."))).toBe(true);
  });

  it("connects, shows status and removes", () => {
    const dry = nomad(["connect", "--dry-run", "--app", "claude-code"]);
    expect(dry.code).toBe(0);
    expect(dry.json.targets[0].server).toBe("add");
    expect(JSON.parse(readFileSync(join(env.home, ".claude.json"), "utf8")).mcpServers.nomad).toBeUndefined();

    const on = nomad(["connect", "--app", "claude-code", "--yes"]);
    expect(on.code).toBe(0);
    const entry = JSON.parse(readFileSync(join(env.home, ".claude.json"), "utf8")).mcpServers.nomad;
    expect(entry.args).toEqual(expect.arrayContaining(["mcp", "--app", "claude-code"]));
    expect(existsSync(join(env.home, ".claude/skills/nomad/SKILL.md"))).toBe(true);

    const status = nomad(["connect", "--status"]);
    expect(status.json.find((s: any) => s.app === "claude-code").connected).toBe(true);

    const off = nomad(["connect", "--remove", "--app", "claude-code", "--yes"]);
    expect(off.code).toBe(0);
    expect(JSON.parse(readFileSync(join(env.home, ".claude.json"), "utf8")).mcpServers.nomad).toBeUndefined();
    expect(existsSync(join(env.home, ".claude/skills/nomad"))).toBe(false);
  });
});
