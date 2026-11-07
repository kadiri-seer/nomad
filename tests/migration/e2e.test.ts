import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { getAdapter } from "@nomad/adapters";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_GITHUB_TOKEN, FAKE_OPENAI_KEY, buildClaudeCode, buildCodex, buildHermes } from "../fixtures/platforms";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => env.cleanup());

async function migrate(source: { adapter: string; root: string; nativeId: string }, dest: { adapter: string; root: string; nativeId?: string }, opts: { mode?: "merge" | "copy" | "replace"; approvals?: Record<string, boolean> } = {}) {
  const plan = await env.nomad.plan({ source: { kind: "location", ...source }, destination: dest, mode: opts.mode });
  expect(plan.blocked).toEqual([]);
  const receipt = await env.nomad.execute(plan.id, opts.approvals ?? {});
  return { plan, receipt };
}

describe("OpenClaw to Claude Code", () => {
  it("migrates identity, instructions, memory, skills and records what cannot move", async () => {
    const dest = emptyDir(env.home, "proj-a/.claude");
    const srcHash = treeHash(env.roots.openclaw);
    const { plan, receipt } = await migrate({ adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, { adapter: "claude-code", root: dest });
    expect(receipt.status).toBe("success");
    expect(receipt.verification.every((v) => v.ok)).toBe(true);
    expect(treeHash(env.roots.openclaw)).toBe(srcHash);

    const claudeMd = read(join(dest, "CLAUDE.md"));
    expect(claudeMd).toContain("# Kestrel");
    expect(claudeMd).toContain("Keep replies short and practical.");
    expect(claudeMd).toContain("@nomad/");
    expect(claudeMd).not.toContain(FAKE_OPENAI_KEY);
    expect(claudeMd).toContain("[REDACTED:openai-key]");
    expect(existsSync(join(dest, "skills/weather-brief/SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "skills/weather-brief/scripts/fetch.py"))).toBe(true);

    // Routines cannot be scheduled in Claude Code: listed, never dropped silently.
    expect(plan.unsupported.some((u) => u.category === "workflows" && u.item === "Morning brief")).toBe(true);
    expect(plan.manualSteps.some((s) => s.includes("Morning brief"))).toBe(true);
    // The OpenClaw model is Anthropic, so it is applied without the provider prefix.
    expect(JSON.parse(read(join(dest, "settings.json"))).model).toBe("claude-sonnet-4-5");
    // browser deny has no Claude Code equivalent and is reported.
    expect(plan.permissions.unenforced.some((u) => u.includes("browser"))).toBe(true);

    // Reading the destination back recognizes the same portable agent.
    const back = await env.nomad.readLocation("claude-code", dest, "main");
    expect(back.doc.id).toBe(plan.agent.id);
    expect(env.nomad.store.listAgents()).toHaveLength(1);
  });
});

describe("Claude Code to Codex", () => {
  it("maps permissions conservatively and converts commands to prompts", async () => {
    const dest = emptyDir(env.home, "fresh/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: env.roots.claude, nativeId: "main" }, { adapter: "codex", root: dest });
    expect(receipt.status).toBe("success");
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(cfg.sandbox_mode).toBe("workspace-write");
    expect(cfg.sandbox_workspace_write.network_access).toBe(false);
    expect(cfg.approval_policy).toBe("on-request");
    expect(cfg.model).toBeUndefined(); // Anthropic model is not written into Codex
    expect(plan.unsupported.some((u) => u.category === "models")).toBe(true);
    expect(cfg.mcp_servers.github.command).toBe("npx");
    expect(cfg.mcp_servers.github.env).toBeUndefined();
    expect(read(join(dest, "config.toml"))).not.toContain(FAKE_GITHUB_TOKEN);
    expect(plan.manualSteps.some((s) => s.includes("GITHUB_TOKEN"))).toBe(true);
    expect(existsSync(join(dest, "prompts/release-notes.md"))).toBe(true);
    expect(existsSync(join(dest, "skills/pdf-tools/SKILL.md"))).toBe(true);
    expect(plan.conversions.some((c) => c.from === "Claude Code slash command")).toBe(true);
    expect(read(join(dest, "AGENTS.md"))).toContain("TypeScript strict mode");
  });
});

describe("Codex to Hermes", () => {
  it("writes persona, skills, MCP config and keeps existing Hermes data", async () => {
    const { plan, receipt } = await migrate({ adapter: "codex", root: env.roots.codex, nativeId: "main" }, { adapter: "hermes", root: env.roots.hermes });
    expect(receipt.status).toBe("success");
    const soul = read(join(env.roots.hermes, "SOUL.md"));
    expect(soul).toContain("You are Iris"); // existing persona kept
    expect(soul).toContain("small, reviewable commits");
    const cfgText = read(join(env.roots.hermes, "config.yaml"));
    expect(cfgText).toContain("# Hermes configuration"); // comments preserved
    const cfg = parseYaml(cfgText);
    expect(cfg.mcp_servers.filesystem).toBeDefined();
    expect(cfg.mcp_servers.docs.command).toBe("npx");
    expect(cfg.model.default).toBe("anthropic/claude-sonnet-4-5"); // merge keeps the existing model
    expect(existsSync(join(env.roots.hermes, "skills/nomad-imports/sql-helper/SKILL.md"))).toBe(true);
    expect(plan.conflicts.length).toBeGreaterThan(0);
  });
});

describe("Hermes to OpenClaw", () => {
  it("imports memory and schedules disabled", async () => {
    const dest = join(env.home, "oc2");
    const { receipt } = await migrate({ adapter: "hermes", root: env.roots.hermes, nativeId: "default" }, { adapter: "openclaw", root: dest });
    expect(receipt.status).toBe("success");
    const jobs = JSON.parse(read(join(dest, "cron/jobs.json"))).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].enabled).toBe(false);
    expect(jobs[0].payload.message).toContain("retrieval augmented generation");
    const mem = read(join(dest, "workspace/MEMORY.md"));
    expect(mem).toContain("staging.internal");
    const user = read(join(dest, "workspace/USER.md"));
    expect(user).toContain("Africa/Lagos");
    expect(receipt.disabledRoutines).toEqual(["Daily research digest"]);
  });
});

describe("OpenClaw to Hermes", () => {
  it("writes § memory, paused cron jobs and archives daily logs", async () => {
    const fresh = join(env.home, "h2");
    const { receipt, plan } = await migrate({ adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, { adapter: "hermes", root: fresh });
    expect(receipt.status).toBe("success");
    const mem = read(join(fresh, "memories/MEMORY.md"));
    expect(mem.split("§").length).toBe(3);
    expect(read(join(fresh, "memories/USER.md"))).toContain("data engineer");
    expect(existsSync(join(fresh, "memories/archive/2026-10-30.md"))).toBe(true);
    const jobs = JSON.parse(read(join(fresh, "cron/jobs.json"))).jobs;
    expect(jobs[0]).toMatchObject({ enabled: false, state: "paused", schedule: { kind: "cron", expr: "0 7 * * *" }, timezone: "Africa/Lagos" });
    expect(plan.compatibility.categories.find((c) => c.category === "workflows")!.status).toBe("full");
  });
});

describe("structured merges", () => {
  it("merges into an existing config.toml without dropping either side", async () => {
    const { receipt } = await migrate({ adapter: "hermes", root: env.roots.hermes, nativeId: "default" }, { adapter: "codex", root: env.roots.codex });
    expect(receipt.status).toBe("success");
    const cfg = parseToml(read(join(env.roots.codex, "config.toml"))) as any;
    expect(cfg.mcp_servers.docs.command).toBe("npx");
    expect(cfg.mcp_servers.filesystem.command).toBe("npx");
    expect(cfg.model).toBe("gpt-5-codex");
    expect(cfg.profiles.fast.model).toBe("gpt-5-mini");
  });
});

describe("several agents in one single-file platform", () => {
  it("verifies each agent against its own section", async () => {
    const dest = emptyDir(env.home, "two/.codex");
    const a = await migrate({ adapter: "claude-code", root: env.roots.claude, nativeId: "main" }, { adapter: "codex", root: dest });
    const b = await migrate({ adapter: "hermes", root: env.roots.hermes, nativeId: "default" }, { adapter: "codex", root: dest }, { approvals: { broaderPermissions: true } });
    expect(a.receipt.status).toBe("success");
    expect(b.receipt.status).toBe("success");
    expect(read(join(dest, "AGENTS.md")).match(/nomad:begin agent=/g)).toHaveLength(2);
  });
});

describe("Generic package folder round trip", () => {
  it("is lossless through a package folder", async () => {
    const folder = join(env.home, "exported-folder");
    const { plan, receipt } = await migrate({ adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, { adapter: "generic", root: folder });
    expect(receipt.status).toBe("success");
    const back = await env.nomad.readLocation("generic", folder, "package", { register: false });
    const original = env.nomad.store.latestDocument(plan.agent.id)!;
    expect(back.doc.instructions).toEqual(original.instructions);
    expect(back.doc.memory).toEqual(original.memory);
    expect(back.doc.skills).toEqual(original.skills);
  });
});

describe("conflict handling", () => {
  it("merge keeps different existing files and reports them", async () => {
    const dest = emptyDir(env.home, "p/.claude");
    writeFileSync(join(dest, "settings.json"), JSON.stringify({ model: "claude-haiku-4-5", theme: "dark" }));
    const { plan, receipt } = await migrate({ adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, { adapter: "claude-code", root: dest });
    expect(receipt.status).toBe("success");
    const s = JSON.parse(read(join(dest, "settings.json")));
    expect(s.model).toBe("claude-haiku-4-5");
    expect(s.theme).toBe("dark");
    expect(plan.conflicts.some((c) => c.detail.includes("model"))).toBe(true);
  });

  it("replace requires explicit approval for content Nomad did not write", async () => {
    writeFileSync(join(env.roots.codex, "config.toml"), read(join(env.roots.codex, "config.toml")).replace('approval_policy = "on-request"', 'approval_policy = "untrusted"'));
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "claude-code", root: env.roots.claude, nativeId: "main" }, destination: { adapter: "codex", root: env.roots.codex }, mode: "replace" });
    expect(plan.approvalsRequired).toContain("replace");
    await expect(env.nomad.execute(plan.id)).rejects.toThrow(/approval/i);
    const r = await env.nomad.execute(plan.id, { replace: true, broaderPermissions: true });
    expect(r.status).toBe("success");
    expect((parseToml(read(join(env.roots.codex, "config.toml"))) as any).approval_policy).toBe("on-request");
  });

  it("detects files edited after Nomad wrote them", async () => {
    const dest = emptyDir(env.home, "q/.claude");
    await migrate({ adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, { adapter: "claude-code", root: dest });
    const skill = join(dest, "skills/weather-brief/SKILL.md");
    writeFileSync(skill, read(skill) + "\nMy local tweak.\n");
    writeFileSync(join(env.roots.openclaw, "workspace/skills/weather-brief/SKILL.md"), "---\nname: weather-brief\ndescription: changed upstream\n---\n\nNew text.\n");
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, destination: { adapter: "claude-code", root: dest } });
    const op = plan.operations.find((o) => o.path.endsWith("weather-brief/SKILL.md"))!;
    expect(op.action).toBe("keep-existing");
    expect(op.userModified).toBe(true);
    const replacePlan = await env.nomad.plan({ source: { kind: "location", adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, destination: { adapter: "claude-code", root: dest }, mode: "replace" });
    expect(replacePlan.approvalsRequired).toContain("overwrite-modified");
  });

  it("copy mode creates a separate agent", async () => {
    const { plan, receipt } = await migrate({ adapter: "hermes", root: env.roots.hermes, nativeId: "default" }, { adapter: "openclaw", root: env.roots.openclaw }, { mode: "copy" });
    expect(receipt.status).toBe("success");
    expect(plan.destination.nativeId).not.toBe("main");
    const cfg = JSON5.parse(read(join(env.roots.openclaw, "openclaw.json")));
    expect(cfg.agents.list.map((a: any) => a.id)).toContain("main");
    expect(cfg.agents.list.find((a: any) => a.id === plan.destination.nativeId).workspace).toContain("workspace-");
    // the original agent is untouched
    expect(read(join(env.roots.openclaw, "workspace/SOUL.md"))).toContain("Kestrel");
    const refs = await getAdapter("openclaw").discover(env.roots.openclaw);
    expect(refs).toHaveLength(2);
  });

  it("refuses copy mode for single agent platforms", async () => {
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "hermes", root: env.roots.hermes, nativeId: "default" }, destination: { adapter: "codex", root: env.roots.codex }, mode: "copy" });
    expect(plan.blocked.length).toBeGreaterThan(0);
  });
});

describe("permission safety", () => {
  it("requires approval when the destination policy would widen", async () => {
    // Hermes allowlists shell commands; the existing Codex policy is stricter about
    // nothing, but writing a Hermes allowlist into a read-only Claude Code project must ask.
    const dest = emptyDir(env.home, "ro/.claude");
    writeFileSync(join(dest, "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "hermes", root: env.roots.hermes, nativeId: "default" }, destination: { adapter: "claude-code", root: dest }, mode: "replace" });
    expect(plan.permissions.widened.length).toBeGreaterThan(0);
    expect(plan.approvalsRequired).toContain("broader-permissions");
  });

  it("never turns a restriction into broader access when mapping", async () => {
    const dest = emptyDir(env.home, "c/.codex");
    const { receipt } = await migrate({ adapter: "claude-code", root: env.roots.claude, nativeId: "subagent:code-reviewer" }, { adapter: "codex", root: dest });
    expect(receipt.status).toBe("success");
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    // write and shell were denied for the reviewer: Codex is read-only and asks for commands
    expect(cfg.sandbox_mode).toBe("read-only");
    expect(cfg.approval_policy).toBe("untrusted");
  });
});

describe("transactions and safety", () => {
  it("rolls back every file when a write fails part way", async () => {
    const dest = emptyDir(env.home, "rb/.claude");
    writeFileSync(join(dest, "CLAUDE.md"), "original\n");
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, destination: { adapter: "claude-code", root: dest } });
    // Make the skills path a file so creating the skill directory fails mid-run.
    writeFileSync(join(dest, "skills"), "not a directory");
    const r = await env.nomad.execute(plan.id);
    expect(r.status).toBe("failed-rolled-back");
    expect(read(join(dest, "CLAUDE.md"))).toBe("original\n");
    expect(existsSync(join(dest, "nomad"))).toBe(false);
  });

  it("refuses to write through symlinks", async () => {
    const { symlinkSync, mkdirSync } = await import("node:fs");
    const dest = emptyDir(env.home, "sl/.claude");
    const outside = emptyDir(env.home, "outside");
    mkdirSync(join(outside, "x"));
    symlinkSync(outside, join(dest, "skills"));
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, destination: { adapter: "claude-code", root: dest } });
    expect(plan.blocked.some((b) => b.includes("symlink"))).toBe(true);
  });

  it("detects destination changes between preview and execution", async () => {
    const dest = emptyDir(env.home, "chg/.claude");
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, destination: { adapter: "claude-code", root: dest } });
    writeFileSync(join(dest, "CLAUDE.md"), "written meanwhile\n");
    const r = await env.nomad.execute(plan.id);
    expect(r.status).toBe("failed-rolled-back");
    expect(read(join(dest, "CLAUDE.md"))).toBe("written meanwhile\n");
  });

  it("backs up and restores the destination", async () => {
    const before = treeHash(env.roots.codex);
    const { receipt } = await migrate({ adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, { adapter: "codex", root: env.roots.codex });
    expect(treeHash(env.roots.codex)).not.toBe(before);
    const preview = await env.nomad.previewRestore(receipt.backupId!);
    expect(preview.changes).toBeGreaterThan(0);
    await env.nomad.restore(receipt.backupId!);
    expect(treeHash(env.roots.codex)).toBe(before);
  });
});

describe("identity and versions", () => {
  it("does not create versions or duplicates when nothing changed", async () => {
    const a = await env.nomad.readLocation("openclaw", env.roots.openclaw, "main");
    const b = await env.nomad.readLocation("openclaw", env.roots.openclaw, "main");
    expect(b.doc.id).toBe(a.doc.id);
    expect(b.version).toBe(a.version);
    writeFileSync(join(env.roots.openclaw, "workspace/AGENTS.md"), "# AGENTS.md\n\n- Changed rule.\n");
    const c = await env.nomad.readLocation("openclaw", env.roots.openclaw, "main");
    expect(c.version).toBe(a.version! + 1);
    const cmp = env.nomad.compareVersions(a.doc.id, a.version!, c.version!);
    expect(cmp.changes.some((x) => x.category === "instructions")).toBe(true);
  });

  it("re-migrating updates its own files without conflicts", async () => {
    const dest = emptyDir(env.home, "again/.claude");
    await migrate({ adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, { adapter: "claude-code", root: dest });
    writeFileSync(join(env.roots.openclaw, "workspace/AGENTS.md"), "# AGENTS.md\n\n- A brand new rule.\n");
    const { plan, receipt } = await migrate({ adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, { adapter: "claude-code", root: dest });
    expect(receipt.status).toBe("success");
    expect(plan.approvalsRequired).toEqual([]);
    expect(read(join(dest, "CLAUDE.md"))).toContain("A brand new rule.");
    expect(read(join(dest, "CLAUDE.md"))).not.toContain("Keep replies short");
  });
});

describe("export and import", () => {
  it("round trips through an .agentpack and recognizes the agent on import", async () => {
    const r = await env.nomad.readLocation("hermes", env.roots.hermes, "default");
    const out = join(env.home, "iris.agentpack");
    const exp = await env.nomad.exportAgent({ kind: "stored", agentId: r.doc.id }, { outPath: out });
    expect(exp.path).toBe(out);
    const bytes = readFileSync(out);
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("sk-or-v1");
    const imp = await env.nomad.importPackage({ path: out });
    expect(imp.ok).toBe(true);
    if (imp.ok) {
      expect(imp.recognized).toBe(true);
      expect(imp.agentId).toBe(r.doc.id);
    }
    // Then migrate the package into a fresh Claude Code
    const dest = emptyDir(env.home, "fromPack/.claude");
    const plan = await env.nomad.plan({ source: { kind: "package", path: out }, destination: { adapter: "claude-code", root: dest } });
    // Hermes allowlists shell commands, which is broader than a fresh Claude Code project.
    expect(plan.approvalsRequired).toEqual(["broader-permissions"]);
    const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
    expect(receipt.status).toBe("success");
    expect(env.nomad.store.listAgents()).toHaveLength(1);
  });
});

describe("guided destinations", () => {
  it("writes a kit and changes nothing else", async () => {
    const out = join(env.home, "chatgpt-kit");
    const { receipt, plan } = await migrate({ adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, { adapter: "chatgpt", root: out });
    expect(receipt.status).toBe("success");
    expect(plan.destination.guided).toBe(true);
    expect(read(join(out, "custom-instructions-how-to-respond.txt"))).toContain("Kestrel");
    expect(read(join(out, "STEPS.md"))).toContain("Custom instructions");
    expect(read(join(out, "routines.md"))).toContain("Morning brief");
  });
});

describe("experimental file adapters", () => {
  it("Cursor gets a rules file and MCP config", async () => {
    const proj = emptyDir(env.home, "cursor-proj");
    const { receipt } = await migrate({ adapter: "claude-code", root: env.roots.claude, nativeId: "main" }, { adapter: "cursor", root: proj });
    expect(receipt.status).toBe("success");
    const mcp = JSON.parse(read(join(proj, ".cursor/mcp.json")));
    expect(mcp.mcpServers.github.env.GITHUB_TOKEN).toBe("${GITHUB_TOKEN}");
  });

  it("Gemini CLI gets GEMINI.md and settings.json", async () => {
    const g = emptyDir(env.home, ".gemini");
    const { receipt } = await migrate({ adapter: "codex", root: env.roots.codex, nativeId: "main" }, { adapter: "gemini-cli", root: g });
    expect(receipt.status).toBe("success");
    expect(read(join(g, "GEMINI.md"))).toContain("reviewable commits");
    expect(JSON.parse(read(join(g, "settings.json"))).mcpServers.docs.command).toBe("npx");
  });
});

export { buildClaudeCode, buildCodex, buildHermes };
