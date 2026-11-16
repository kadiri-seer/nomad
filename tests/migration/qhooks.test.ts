import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId, qhooksReferralExtras, QHOOKS_REFERRER } from "@nomad/adapters";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { QHOOKS_NOMAD_URL, QHOOKS_OWN_REF_URL, QHOOKS_URL, buildClaudeCodeQHooks, buildCodexQHooks } from "../fixtures/qhooks";

/**
 * QHooks setups (a hosted, keyless server whose prepared transactions the user's wallet signs) moving
 * between platforms. At QHooks' request Nomad adds its referral: ref=nomad on an address that names no
 * referral yet, and a short note asking the agent to pass Nomad's referrer.
 */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "qhooks");
  mkdirSync(src, { recursive: true });
});
afterEach(() => env.cleanup());

type Loc = { adapter: string; root: string; nativeId: string };

async function migrate(source: Loc, dest: { adapter: string; root: string }, components?: string[]) {
  const plan = await env.nomad.plan({ source: { kind: "location", ...source }, destination: dest, ...(components ? { components: components as never } : {}) });
  expect(plan.blocked).toEqual([]);
  const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
  expect(receipt.status, receipt.verification.filter((v) => !v.ok).map((v) => `${v.name}: ${v.detail ?? ""}`).join("; ")).toBe("success");
  return { plan, receipt };
}

const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");
const skillDirs = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

describe("QHooks setups", () => {
  it("Claude Code to Codex: the address gets ref=nomad, the user's own referral stays, and the skill arrives", async () => {
    const cc = buildClaudeCodeQHooks(src);
    const before = treeHash(cc);
    const beforeJson = read(join(src, ".claude.json"));
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(cfg.mcp_servers.qhooks).toEqual({ url: QHOOKS_NOMAD_URL });
    expect(cfg.mcp_servers["qhooks-mine"]).toEqual({ url: QHOOKS_OWN_REF_URL });
    const skill = read(join(dest, "skills/qhooks-referral/SKILL.md"));
    expect(skill).toContain(`"referrer": "${QHOOKS_REFERRER}"`);
    expect(skill).toContain("prepare_trade or prepare_launch");
    expect(skill).toContain("If the user gives you a different referrer for QHooks, use theirs instead.");
    expect(notes(plan)).toContain(`"qhooks" is QHooks' hosted server. It needs no key and never signs or sends anything`);
    expect(notes(plan)).toContain(`Nomad connects "qhooks" as ${QHOOKS_NOMAD_URL}, so QHooks credits trades made through it to Nomad's referral.`);
    expect(notes(plan)).not.toContain(`Nomad connects "qhooks-mine"`);
    expect(warnings(plan)).not.toContain("QHooks");
    // The source is read, never changed.
    expect(treeHash(cc)).toBe(before);
    expect(read(join(src, ".claude.json"))).toBe(beforeJson);
  });

  it("Codex to Claude Code to OpenClaw: ref=nomad is added once and the skill is never doubled", async () => {
    const x = buildCodexQHooks(src);
    const ccHome = emptyDir(env.home, "x2c");
    const cc = emptyDir(ccHome, ".claude");
    await migrate({ adapter: "codex", root: x, nativeId: "main" }, { adapter: "claude-code", root: cc });
    expect(JSON.parse(read(join(ccHome, ".claude.json"))).mcpServers.qhooks).toMatchObject({ type: "http", url: QHOOKS_NOMAD_URL });
    expect(skillDirs(join(cc, "skills"))).toEqual(["qhooks-referral"]);

    const oc = emptyDir(env.home, "c2o/.openclaw");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "openclaw", root: oc });
    const cfg = JSON5.parse(read(join(oc, "openclaw.json"))) as any;
    expect(cfg.mcp.servers.qhooks).toEqual({ url: QHOOKS_NOMAD_URL, transport: "streamable-http" });
    // Already ref=nomad: no second ref and no "connects" note; the skill moves like any other skill.
    expect(notes(plan)).not.toContain("Nomad connects");
    const skills = skillDirs(join(oc, "workspace/skills"));
    expect(skills.filter((s) => s.startsWith("qhooks-referral"))).toEqual(["qhooks-referral"]);
    expect(read(join(oc, "workspace/skills/qhooks-referral/SKILL.md"))).toContain(QHOOKS_REFERRER);
  });

  it("Claude Code to Gemini CLI: no skill system, so the note goes into the instructions", async () => {
    const cc = buildClaudeCodeQHooks(src);
    const dest = emptyDir(env.home, "c2g/.gemini");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "gemini-cli", root: dest });
    const servers = JSON.parse(read(join(dest, "settings.json"))).mcpServers;
    expect(servers.qhooks.httpUrl).toBe(QHOOKS_NOMAD_URL);
    expect(servers["qhooks-mine"].httpUrl).toBe(QHOOKS_OWN_REF_URL);
    const md = read(join(dest, "GEMINI.md"));
    expect(md).toContain(`"referrer": "${QHOOKS_REFERRER}"`);
    expect(md).toContain("Read QHooks markets before preparing a trade.");
    expect(existsSync(join(dest, "skills"))).toBe(false);
  });

  it("only the components the user chose: tools alone get ref=nomad but no skill or instruction", async () => {
    const x = buildCodexQHooks(src);
    const ccHome = emptyDir(env.home, "tools-only");
    const cc = emptyDir(ccHome, ".claude");
    await migrate({ adapter: "codex", root: x, nativeId: "main" }, { adapter: "claude-code", root: cc }, ["tools"]);
    expect(JSON.parse(read(join(ccHome, ".claude.json"))).mcpServers.qhooks.url).toBe(QHOOKS_NOMAD_URL);
    expect(existsSync(join(cc, "skills/qhooks-referral"))).toBe(false);
    expect(existsSync(join(cc, "CLAUDE.md")) ? read(join(cc, "CLAUDE.md")) : "").not.toContain(QHOOKS_REFERRER);
  });

  it("a user who already has their own referral gets no Nomad skill", async () => {
    const x = join(src, ".codex");
    mkdirSync(x, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(x, "config.toml"), `[mcp_servers.qhooks]\nurl = "${QHOOKS_OWN_REF_URL}"\n`);
    const ccHome = emptyDir(env.home, "own");
    const cc = emptyDir(ccHome, ".claude");
    const { plan } = await migrate({ adapter: "codex", root: x, nativeId: "main" }, { adapter: "claude-code", root: cc });
    expect(JSON.parse(read(join(ccHome, ".claude.json"))).mcpServers.qhooks.url).toBe(QHOOKS_OWN_REF_URL);
    expect(existsSync(join(cc, "skills/qhooks-referral"))).toBe(false);
    expect(notes(plan)).not.toContain("Nomad connects");
  });
});

describe("QHooks recognition", () => {
  const remote = (url: string, enabled = true): Tool => ({ name: "x", kind: "mcp", enabled, mcp: { transport: "http", url, args: [], env: {}, headers: {} } }) as unknown as Tool;
  const local = (command: string, args: string[] = []): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "stdio", command, args, env: {}, headers: {} } }) as unknown as Tool;
  const urlAfter = (url: string) => applyKnownServerProfile(remote(url)).tool.mcp!.url;

  it("recognises QHooks' server", () => {
    for (const u of ["https://qhooks.com/mcp", "https://qhooks.com/mcp/", "https://QHOOKS.com/mcp", "https://qhooks.com:443/mcp", QHOOKS_OWN_REF_URL, QHOOKS_NOMAD_URL]) {
      expect(knownServerId(remote(u)), u).toBe("qhooks");
    }
  });

  it("ignores look-alikes, which get no ref and no notes", () => {
    for (const u of [
      "http://qhooks.com/mcp",
      "https://qhooks.com.evil.example/mcp",
      "https://evil.example/qhooks.com/mcp",
      "https://www.qhooks.com/mcp",
      "https://qhooks.co/mcp",
      "https://qhooks.com:8443/mcp",
      "https://user@qhooks.com/mcp",
      "https://qhooks.com/mcp/evil",
      "https://qhooks.com/api/mcp",
      "not a url"
    ]) {
      expect(knownServerId(remote(u)), u).toBeNull();
      const r = applyKnownServerProfile(remote(u));
      expect(r.tool.mcp!.url, u).toBe(u);
      expect(r.notes, u).toEqual([]);
    }
    expect(knownServerId(local("npx", ["-y", "qhooks"]))).toBeNull();
  });

  it("adds ref=nomad without touching the rest of the address", () => {
    expect(urlAfter(QHOOKS_URL)).toBe(QHOOKS_NOMAD_URL);
    expect(urlAfter("https://qhooks.com/mcp/")).toBe("https://qhooks.com/mcp/?ref=nomad");
    expect(urlAfter("https://qhooks.com/mcp?chain=4663")).toBe("https://qhooks.com/mcp?chain=4663&ref=nomad");
    expect(urlAfter("https://qhooks.com/mcp?")).toBe("https://qhooks.com/mcp?ref=nomad");
    expect(urlAfter("https://qhooks.com/mcp?a=1&")).toBe("https://qhooks.com/mcp?a=1&ref=nomad");
    expect(urlAfter("https://qhooks.com/mcp#x")).toBe("https://qhooks.com/mcp?ref=nomad#x");
    // Any referral already named stays, even an empty one.
    for (const u of [QHOOKS_OWN_REF_URL, QHOOKS_NOMAD_URL, "https://qhooks.com/mcp?ref=", "https://qhooks.com/mcp?a=1&ref=bob"]) expect(urlAfter(u)).toBe(u);
  });

  it("the referral note is added once, only for a QHooks server that gets ref=nomad", () => {
    const doc = (tools: Tool[], extra: Record<string, unknown> = {}) => ({ tools, skills: [], instructions: [], ...extra }) as never;
    const both = { skills: true, instructions: true };
    expect(qhooksReferralExtras(doc([remote(QHOOKS_URL)]), both).skills.map((s) => s.name)).toEqual(["qhooks-referral"]);
    expect(qhooksReferralExtras(doc([remote(QHOOKS_URL)]), { skills: false, instructions: true }).instructions.map((i) => i.id)).toEqual(["qhooks-referral"]);
    expect(qhooksReferralExtras(doc([remote(QHOOKS_URL)]), { skills: false, instructions: false })).toEqual({ skills: [], instructions: [] });
    for (const tools of [[remote(QHOOKS_OWN_REF_URL)], [remote(QHOOKS_NOMAD_URL)], [remote(QHOOKS_URL, false)], [remote("https://qhooks.co/mcp")], []]) {
      expect(qhooksReferralExtras(doc(tools), both)).toEqual({ skills: [], instructions: [] });
    }
    expect(qhooksReferralExtras(doc([remote(QHOOKS_URL)], { skills: [{ name: "qhooks-referral" }] }), both)).toEqual({ skills: [], instructions: [] });
  });

  it("the referrer is a valid, checksummed address", () => {
    expect(QHOOKS_REFERRER).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(QHOOKS_REFERRER).toBe("0xD4bA760227cdDCD879c9d05Fbd908eb69b50dD7c");
  });

  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/qhooks-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /supports qhooks/i, /qhooks integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(/(?<!Robin)Hood Chain/.test(text)).toBe(false);
  });
});
