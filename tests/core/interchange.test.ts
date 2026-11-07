import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import JSON5 from "json5";
import { createDocument, utf8 } from "@nomad/core";
import { createZip, unpackAgent, writeInterchange } from "@nomad/archive";
import { getAdapter } from "@nomad/adapters";
import { emptyDir, read, setup, type Env } from "../helpers";

function sample() {
  const d = createDocument({ name: "Ada", platform: "openclaw", description: "Research helper" });
  d.identity.persona = "You are Ada.";
  d.instructions.push({ id: "a", kind: "agent", content: "Cite sources." }, { id: "b", kind: "conventions", title: "TOOLS.md", content: "Server is atlas." });
  d.memory.push(
    { id: "m1", kind: "preference", scope: "user", title: "Preferences", content: "Likes short answers", tags: [] },
    { id: "m2", kind: "daily-log", scope: "agent", date: "2026-11-01", content: "Line one\nLine two", tags: [] }
  );
  d.skills.push({ name: "digest", description: "Summarise", instructions: "Do it.", dependencies: [], platforms: [], allowedTools: [], config: {}, references: [], files: [{ path: "run.sh", encoding: "utf8", content: "echo hi\n", executable: true }], frontmatter: {}, invocation: "auto" });
  d.tools.push({ name: "gh", kind: "mcp", mcp: { transport: "stdio", command: "npx", args: ["gh"], env: {}, headers: {} }, permissions: [], platforms: [], enabled: true });
  d.workflows.push({ id: "w", name: "Morning", trigger: { kind: "interval", everyMs: 7_200_000 }, timezone: "Africa/Lagos", actions: [{ kind: "prompt", text: "Brief me." }], requiredTools: [], dependencies: [], conditions: [], sourceEnabled: true, enabled: false });
  d.permissions = { mode: "ask", rules: [{ capability: "network", effect: "deny" }, { capability: "shell", effect: "ask", pattern: "git push" }], notes: [] };
  d.models.preferred = "anthropic/claude-sonnet-4-5";
  return d;
}

describe("interchange archives (.jetpack)", () => {
  it("round trips everything Nomad stores", () => {
    const d = sample();
    const { files, carried } = writeInterchange(d);
    expect(carried).toEqual(["1 tool(s)"]);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("jetpack.json")!));
    expect(manifest).toMatchObject({ schemaVersion: "0.1", id: d.id, name: "Ada", models: [{ provider: "anthropic", model: "claude-sonnet-4-5" }] });
    expect(manifest.policy.rules).toContainEqual({ effect: "deny", on: "network" });
    expect(new TextDecoder().decode(files.get("routines/morning.json")!)).toContain('"every": "2h"');
    const u = unpackAgent(createZip(files));
    expect(u.ok).toBe(true);
    expect(u.format).toBe("interchange");
    expect(u.doc!.id).toBe(d.id);
    expect(u.doc!.instructions).toEqual(d.instructions);
    expect(u.doc!.memory.map((m) => m.kind).sort()).toEqual(["daily-log", "preference"]);
    expect(u.doc!.skills[0].files[0].path).toBe("run.sh");
    expect(u.doc!.tools[0].name).toBe("gh");
    expect(u.doc!.workflows[0]).toMatchObject({ trigger: { kind: "interval", everyMs: 7_200_000 }, sourceEnabled: true, enabled: false });
    expect(u.doc!.permissions.rules).toContainEqual(expect.objectContaining({ capability: "shell", effect: "ask", pattern: "git push" }));
  });

  it("reads archives written by other tools", () => {
    const manifest = { schemaVersion: "0.1", id: "01JD5XKZ8M3R7T0WQ4V2B6N9CE", name: "pilot", models: [{ model: "gpt-5" }], capabilities: ["shell"], policy: { mode: "readOnly", rules: [{ effect: "deny", on: "tool", tool: "Bash" }] }, "x-other": { kept: true } };
    const z = zipSync({
      "jetpack.json": utf8(JSON.stringify(manifest)),
      "AGENTS.md": utf8("Review pull requests."),
      "SOUL.md": utf8("Calm reviewer."),
      "MEMORY.md": utf8("Notes about the team.\n- Uses pnpm\n- Main branch is protected\n"),
      "memory/2026-10-01.md": utf8("Shipped v2."),
      "routines/weekly.json": utf8(JSON.stringify({ name: "Weekly", instruction: "Summarise PRs.", enabled: true, timezone: "UTC", schedule: { kind: "cron", expression: "0 9 * * 1" } })),
      "skills/trace/SKILL.md": utf8("---\nname: trace\ndescription: Trace evidence\n---\n\nFollow the evidence.")
    });
    const u = unpackAgent(z);
    expect(u.ok).toBe(true);
    const doc = u.doc!;
    expect(doc.name).toBe("pilot");
    expect(doc.identity.persona).toBe("Calm reviewer.");
    expect(doc.memory.filter((m) => m.kind === "fact").map((m) => m.content)).toEqual(["Uses pnpm", "Main branch is protected"]);
    expect(doc.memory.some((m) => m.kind === "note" && m.content.includes("Notes about the team"))).toBe(true);
    expect(doc.memory.some((m) => m.kind === "daily-log" && m.date === "2026-10-01")).toBe(true);
    expect(doc.workflows[0]).toMatchObject({ trigger: { kind: "cron", expr: "0 9 * * 1" }, enabled: false, sourceEnabled: true });
    expect(doc.permissions.mode).toBe("read-only");
    expect(doc.permissions.rules[0]).toMatchObject({ capability: "tool", effect: "deny", pattern: "Bash" });
    expect(doc.extensions["x-other"]).toEqual({ kept: true });
    expect(u.warnings[0]).toContain("Interchange archive");
  });

  it("still rejects unsafe archives", () => {
    expect(unpackAgent(zipSync({ "../AGENTS.md": utf8("x") })).ok).toBe(false);
  });
});

describe("interchange through the engine", () => {
  let env: Env;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => env.cleanup());

  it("exports a .jetpack and migrates it into another platform", async () => {
    const r = await env.nomad.readLocation("openclaw", env.roots.openclaw, "main");
    const out = join(env.home, "kestrel.jetpack");
    const exp = await env.nomad.exportAgent({ kind: "stored", agentId: r.doc.id }, { outPath: out });
    expect(exp.receipt.format).toBe("interchange");
    expect(existsSync(out)).toBe(true);
    const dest = emptyDir(env.home, "j/.claude");
    const plan = await env.nomad.plan({ source: { kind: "package", path: out }, destination: { adapter: "claude-code", root: dest } });
    const receipt = await env.nomad.execute(plan.id);
    expect(receipt.status).toBe("success");
    expect(read(join(dest, "CLAUDE.md"))).toContain("Keep replies short");
    expect(env.nomad.store.listAgents()).toHaveLength(1);
  });
});

describe("OpenClaw keyed roster (agents.entries)", () => {
  let env: Env;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => env.cleanup());

  it("discovers keyed agents and pins the default when adding one", async () => {
    const root = env.roots.openclaw;
    writeFileSync(join(root, "openclaw.json"), JSON.stringify({ agents: { defaults: { workspace: join(root, "workspace") }, entries: { main: { name: "Kestrel" } } } }));
    const a = getAdapter("openclaw");
    expect((await a.discover(root)).map((r) => r.nativeId)).toEqual(["main"]);
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "hermes", root: env.roots.hermes, nativeId: "default" }, destination: { adapter: "openclaw", root }, mode: "copy", targetName: "Iris" });
    const receipt = await env.nomad.execute(plan.id);
    expect(receipt.status).toBe("success");
    const cfg = JSON5.parse(readFileSync(join(root, "openclaw.json"), "utf8"));
    expect(Object.keys(cfg.agents.entries).sort()).toEqual(["iris", "main"]);
    expect(cfg.agents.list).toBeUndefined();
    expect(cfg.agents.defaults.systemAgent.agentId).toBe("main");
    expect((await a.discover(root)).map((r) => r.nativeId).sort()).toEqual(["iris", "main"]);
  });

  it("places other agents beside a shared workspace", async () => {
    const root = env.roots.openclaw;
    const shared = join(env.home, "agents-ws");
    mkdirSync(join(shared, "research"), { recursive: true });
    writeFileSync(join(shared, "research", "IDENTITY.md"), "- **Name:** Research\n");
    writeFileSync(join(root, "openclaw.json"), JSON.stringify({ agents: { defaults: { workspace: shared, systemAgent: { agentId: "main" } }, entries: { main: {}, research: {} } } }));
    const refs = await getAdapter("openclaw").discover(root);
    expect(refs.find((r) => r.nativeId === "research")!.name).toBe("Research");
  });
});
