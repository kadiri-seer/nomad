import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "@nomad/adapters";
import { setup, treeHash, type Env } from "../helpers";
import { FAKE_GITHUB_TOKEN, FAKE_OPENAI_KEY } from "../fixtures/platforms";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => env.cleanup());

describe("OpenClaw adapter", () => {
  it("detects, discovers and reads the workspace", async () => {
    const a = getAdapter("openclaw");
    expect((await a.detect(env.roots.openclaw)).detected).toBe(true);
    const refs = await a.discover(env.roots.openclaw);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("Kestrel");
    const { doc } = await a.read!(env.roots.openclaw, "main");
    expect(doc.identity.name).toBe("Kestrel");
    expect(doc.identity.emoji).toBe("🪶");
    expect(doc.identity.tone).toBe("calm, precise");
    expect(doc.identity.persona).toContain("calm and precise personal assistant");
    expect(doc.instructions.map((i) => i.kind).sort()).toEqual(["agent", "conventions", "heartbeat"]);
    // Every bullet is its own memory entry, never combined.
    const facts = doc.memory.filter((m) => m.source?.path === "MEMORY.md");
    expect(facts.length).toBe(3);
    expect(doc.memory.filter((m) => m.scope === "user").length).toBe(4);
    expect(doc.memory.some((m) => m.kind === "daily-log" && m.date === "2026-10-30")).toBe(true);
    expect(doc.skills[0].name).toBe("weather-brief");
    expect(doc.skills[0].files[0]).toMatchObject({ path: "scripts/fetch.py", executable: true });
    expect(doc.models.preferred).toBe("anthropic/claude-sonnet-4-5");
    expect(doc.workflows[0]).toMatchObject({ name: "Morning brief", trigger: { kind: "cron", expr: "0 7 * * *" }, timezone: "Africa/Lagos", sourceEnabled: true, enabled: false });
    expect(doc.permissions.rules).toContainEqual(expect.objectContaining({ capability: "browser", effect: "deny" }));
    expect(doc.integrations.map((i) => i.name)).toEqual(["telegram"]);
  });
});

describe("Claude Code adapter", () => {
  it("reads main configuration, MCP servers and permissions", async () => {
    const a = getAdapter("claude-code");
    const refs = await a.discover(env.roots.claude);
    expect(refs.map((r) => r.nativeId)).toEqual(["main", "subagent:code-reviewer"]);
    const { doc } = await a.read!(env.roots.claude, "main");
    expect(doc.instructions[0].content).toContain("TypeScript strict mode");
    expect(doc.skills.map((s) => s.name).sort()).toEqual(["pdf-tools", "release-notes"]);
    expect(doc.skills.find((s) => s.name === "release-notes")!.invocation).toBe("manual");
    expect(doc.tools[0]).toMatchObject({ name: "github", kind: "mcp" });
    expect(doc.tools[0].mcp!.env.GITHUB_TOKEN).toEqual({ value: FAKE_GITHUB_TOKEN });
    expect(doc.models.preferred).toBe("claude-opus-4-1");
    const deny = doc.permissions.rules.filter((r) => r.effect === "deny");
    expect(deny).toContainEqual(expect.objectContaining({ capability: "network" }));
    expect(deny).toContainEqual(expect.objectContaining({ capability: "read", pattern: "./.env" }));
  });

  it("reads a subagent with its tool restrictions", async () => {
    const { doc } = await getAdapter("claude-code").read!(env.roots.claude, "subagent:code-reviewer");
    expect(doc.name).toBe("code-reviewer");
    expect(doc.models.preferred).toBe("sonnet");
    const denied = doc.permissions.rules.filter((r) => r.effect === "deny").map((r) => r.capability).sort();
    expect(denied).toEqual(["network", "shell", "write"]);
  });
});

describe("Codex adapter", () => {
  it("reads AGENTS.md, config.toml, skills and prompts", async () => {
    const { doc } = await getAdapter("codex").read!(env.roots.codex, "main");
    expect(doc.instructions[0].content).toContain("small, reviewable commits");
    expect(doc.models).toMatchObject({ preferred: "gpt-5-codex", reasoningEffort: "high" });
    expect(doc.tools.map((t) => t.name)).toEqual(["docs"]);
    expect(doc.skills.map((s) => s.name).sort()).toEqual(["review", "sql-helper"]);
    expect(doc.permissions.rules).toContainEqual(expect.objectContaining({ capability: "network", effect: "deny" }));
    expect(doc.permissions.rules).toContainEqual(expect.objectContaining({ capability: "shell", effect: "ask" }));
  });
});

describe("Hermes adapter", () => {
  it("reads persona, § delimited memory, skills, MCP and cron", async () => {
    const { doc, notes } = await getAdapter("hermes").read!(env.roots.hermes, "default");
    expect(doc.identity.persona).toContain("research assistant");
    expect(doc.memory.filter((m) => m.scope === "agent")).toHaveLength(3);
    expect(doc.memory.filter((m) => m.scope === "user")).toHaveLength(3);
    expect(doc.skills.map((s) => s.name)).toEqual(["arxiv-digest"]);
    expect(doc.tools.map((t) => t.name)).toEqual(["filesystem"]);
    expect(doc.workflows[0]).toMatchObject({ name: "Daily research digest", sourceEnabled: true, enabled: false });
    expect(doc.workflows[0].actions[0]).toEqual({ kind: "skill", name: "arxiv-digest" });
    expect(doc.permissions.rules.map((r) => r.pattern)).toEqual(["git status", "ls"]);
    expect(notes.some((n) => n.message.includes(".env"))).toBe(true);
    expect(JSON.stringify(doc)).not.toContain("sk-or-v1");
  });
});

describe("reading never modifies the source", () => {
  it("leaves every platform tree byte for byte identical", async () => {
    const before = Object.fromEntries(Object.entries(env.roots).map(([k, r]) => [k, treeHash(r)]));
    await env.nomad.readLocation("openclaw", env.roots.openclaw, "main");
    await env.nomad.readLocation("claude-code", env.roots.claude, "main");
    await env.nomad.readLocation("codex", env.roots.codex, "main");
    await env.nomad.readLocation("hermes", env.roots.hermes, "default");
    for (const [k, r] of Object.entries(env.roots)) expect(treeHash(r)).toBe(before[k]);
  });

  it("redacts secrets before storing a read", async () => {
    const r = await env.nomad.readLocation("openclaw", env.roots.openclaw, "main");
    expect(r.scan.findings.some((f) => f.ruleId === "openai-key")).toBe(true);
    expect(JSON.stringify(r.doc)).not.toContain(FAKE_OPENAI_KEY);
    const stored = env.nomad.store.latestDocument(r.doc.id)!;
    expect(JSON.stringify(stored)).not.toContain(FAKE_OPENAI_KEY);
    const cc = await env.nomad.readLocation("claude-code", env.roots.claude, "main");
    expect(cc.doc.tools[0].mcp!.env.GITHUB_TOKEN).toEqual({ secretRef: "GITHUB_TOKEN", redacted: true });
  });
});
