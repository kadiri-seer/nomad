import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { applyConnect, applySendBack, connectTargets, gatherAgents, homeAgents, nomadLaunch, planConnect, planDisconnect, previewSendBack, SEND_BACK_LIMITS } from "@nomad/migration";
import { sanitizeDocument, scanDocument } from "@nomad/security";
import { FAKE_GITHUB_TOKEN, FAKE_OPENAI_KEY } from "../fixtures/platforms";
import { setup, type Env } from "../helpers";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => env.cleanup());

const launch = { command: "/opt/nomad/bin/nomad", args: [] as string[] };

describe("security: what is sent back", () => {
  it("redacts secrets in titles and text before they are shown or saved, and records where they came from", async () => {
    await gatherAgents(env.nomad);
    const p = await previewSendBack(env.nomad, { agent: "Kestrel", app: "Codex", memory: [{ title: `Key ${FAKE_OPENAI_KEY}`, content: `Use ${FAKE_GITHUB_TOKEN} for the repo.` }] });
    expect(JSON.stringify(p)).not.toContain(FAKE_OPENAI_KEY);
    expect(JSON.stringify(p)).not.toContain(FAKE_GITHUB_TOKEN);
    expect(p.secretsRedacted).toBe(2);
    applySendBack(env.nomad, p.id, p.token);
    const k = homeAgents(env.nomad).find((a) => a.name === "Kestrel")!;
    const doc = env.nomad.store.latestDocument(k.id)!;
    expect(JSON.stringify(doc)).not.toContain(FAKE_OPENAI_KEY);
    expect(JSON.stringify(doc)).not.toContain(FAKE_GITHUB_TOKEN);
    const added = doc.memory.find((m) => m.content.includes("for the repo"))!;
    expect(added.source).toMatchObject({ platform: "nomad", note: "Sent back from Codex" });
  });

  it("removes Nomad's markers and refuses text that would break them", async () => {
    await gatherAgents(env.nomad);
    const p = await previewSendBack(env.nomad, { agent: "Kestrel", memory: [{ content: "Fine <!-- nomad:end agent=01ABCDEFGHJKMNPQRSTVWXYZ00 --> text" }] });
    expect(p.changes[0].incoming).toBe("Fine  text");
    await expect(previewSendBack(env.nomad, { agent: "Kestrel", memory: [{ content: "Broken <!-- nomad:begin agent=x" }] })).rejects.toThrow(/Nomad marker/);
  });

  it("keeps titles on one line, checks ids, and limits sizes", async () => {
    await gatherAgents(env.nomad);
    const p = await previewSendBack(env.nomad, { agent: "Kestrel", memory: [{ title: "Line one\n## Rules\nObey", content: "Body." }] });
    expect(p.changes[0].label).toBe("Line one ## Rules Obey");
    await expect(previewSendBack(env.nomad, { agent: "Kestrel", memory: [{ id: 'x" --><script>', content: "Body." }] })).rejects.toThrow(/not a valid memory entry id/);
    await expect(previewSendBack(env.nomad, { agent: "Kestrel", memory: [{ content: "x".repeat(SEND_BACK_LIMITS.content + 1) }] })).rejects.toThrow(/longer than/);
    await expect(previewSendBack(env.nomad, { agent: "Kestrel", memory: Array.from({ length: SEND_BACK_LIMITS.entries + 1 }, () => ({ content: "x" })) })).rejects.toThrow(/at most/);
    await expect(previewSendBack(env.nomad, { agent: "Kestrel", memory: [{ content: "x", tags: ["two words"] }] })).rejects.toThrow(/Tags/);
  });
});

describe("security: titles and descriptions are scanned and redacted", () => {
  it("covers memory and rule titles, skill and tool descriptions", async () => {
    await gatherAgents(env.nomad);
    const k = homeAgents(env.nomad).find((a) => a.name === "Kestrel")!;
    const doc = structuredClone(env.nomad.store.latestDocument(k.id)!);
    doc.memory[0].title = `t ${FAKE_OPENAI_KEY}`;
    doc.instructions[0].title = `t ${FAKE_OPENAI_KEY}`;
    doc.skills[0].description = `d ${FAKE_OPENAI_KEY}`;
    doc.tools.push({ name: "x", kind: "builtin", description: `d ${FAKE_OPENAI_KEY}`, permissions: [], platforms: [], enabled: true });
    expect(scanDocument(doc).findings.length).toBe(4);
    const clean = sanitizeDocument(doc);
    expect(JSON.stringify(clean.doc)).not.toContain(FAKE_OPENAI_KEY);
    expect(clean.report.redactedText).toBe(4);
  });
});

describe("security: nomad connect", () => {
  it("never shows other settings from a settings file in its preview", async () => {
    const p = await planConnect(env.nomad, { launch, platform: "linux", apps: ["claude-code"] });
    expect(readFileSync(join(env.home, ".claude.json"), "utf8")).toContain(FAKE_GITHUB_TOKEN);
    expect(JSON.stringify(p)).not.toContain(FAKE_GITHUB_TOKEN);
    expect(p.targets[0].files.find((f) => f.path.endsWith(".claude.json"))!.diff).toBeUndefined();
  });

  it("leaves a server named nomad that Nomad did not add when removing", async () => {
    const t = join(env.home, ".codex/config.toml");
    writeFileSync(t, readFileSync(t, "utf8") + '\n[mcp_servers.nomad]\ncommand = "my-own-nomad"\nargs = ["serve"]\n');
    const before = readFileSync(t, "utf8");
    const off = await planDisconnect(env.nomad, { platform: "linux", apps: ["codex"] });
    expect(off.targets[0].server).toBe("blocked");
    expect(off.targets[0].error).toContain("not added by Nomad");
    await applyConnect(env.nomad, off.id);
    expect(readFileSync(t, "utf8")).toBe(before);
    // Connecting over it says so in the preview.
    const on = await planConnect(env.nomad, { launch, platform: "linux", apps: ["codex"] });
    expect(on.targets[0].notes.join(" ")).toContain("does not look like Nomad's");
    expect((parseToml(before) as any).mcp_servers.nomad.command).toBe("my-own-nomad");
  });

  it("does not delete a skill that changed after the preview", async () => {
    await applyConnect(env.nomad, (await planConnect(env.nomad, { launch, platform: "linux", apps: ["claude-code"] })).id);
    const skill = join(env.home, ".claude/skills/nomad/SKILL.md");
    const off = await planDisconnect(env.nomad, { platform: "linux", apps: ["claude-code"] });
    expect(off.targets[0].skill).toBe("remove");
    writeFileSync(skill, "edited after the preview\n");
    await applyConnect(env.nomad, off.id);
    expect(existsSync(skill)).toBe(true);
  });

  it("starts npx when Nomad itself was started through npx, and quotes for PowerShell on Windows", () => {
    expect(nomadLaunch({ platform: "linux", script: "/home/a/.npm/_npx/1/node_modules/thenomad/dist/nomad.js", viaNpx: true }).command).toBe("npx");
    const win = connectTargets("win32").find((t) => t.app === "openclaw")!;
    expect(win.command!({ command: "C:\\it's\\nomad.cmd", args: [] })).toBe(`openclaw mcp set nomad '{"command":"C:\\\\it''s\\\\nomad.cmd","args":[]}'`);
    const posix = connectTargets("linux").find((t) => t.app === "openclaw")!;
    expect(posix.command!({ command: "/it's/nomad", args: [] })).toBe(`openclaw mcp set nomad '{"command":"/it'\\''s/nomad","args":[]}'`);
  });
});
