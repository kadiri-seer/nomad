import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId, oddsEngineCreditExtras, ODDSENGINE_CONNECT_URL } from "@nomad/adapters";
import { packAgent, unpackAgent } from "@nomad/archive";
import { scanText } from "@nomad/security";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_ODDSENGINE_KEY, FAKE_ODDSENGINE_SECRETS, ODDSENGINE_KEY_URL, ODDSENGINE_URL, buildClaudeCodeOddsEngine, buildCursorOddsEngineKeyInAddress } from "../fixtures/oddsengine";

/**
 * OddsEngine setups (a hosted server with crypto safety checks and AI models, paid per call; every call needs
 * the account's "Bearer oe_live_..." key) moving between platforms. Keys are fake.
 */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "oddsengine");
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

function allText(dir: string): string {
  if (!existsSync(dir)) return "";
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out.join("\n");
}

function expectNoLeak(...texts: string[]) {
  for (const t of texts) for (const s of FAKE_ODDSENGINE_SECRETS) expect(t.includes(s), "an OddsEngine key leaked").toBe(false);
}

const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");
const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");
const skillDirs = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
const ABOUT = `"oddsengine" is OddsEngine's hosted server, powered by OddsEngine (${ODDSENGINE_CONNECT_URL}).`;

describe("OddsEngine setups", () => {
  it("Claude Code to Codex: the key becomes bearer_token_env_var = ODDSENGINE_API_KEY, never written, and the credit skill arrives", async () => {
    const cc = buildClaudeCodeOddsEngine(src);
    const before = treeHash(cc);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(cfg.mcp_servers.oddsengine).toEqual({ url: ODDSENGINE_URL, bearer_token_env_var: "ODDSENGINE_API_KEY" });
    expect(notes(plan)).toContain(ABOUT);
    expect(notes(plan)).toContain("only read and never move funds");
    expect(notes(plan)).toContain(`Nomad adds a short "oddsengine-credit" note at OddsEngine's request: the agent ends the results of OddsEngine's scan_token and check_before_sign with "Checked by OddsEngine." Delete it any time.`);
    expect(steps(plan)).toContain(`The "oddsengine" key is your OddsEngine API key (oe_live_..., under API keys at ${ODDSENGINE_CONNECT_URL}); keys are never copied. OddsEngine refuses calls without it, so the server does not work on Codex until ODDSENGINE_API_KEY is set.`);
    expect(warnings(plan)).not.toContain("OddsEngine");
    const skill = read(join(dest, "skills/oddsengine-credit/SKILL.md"));
    expect(skill).toContain("scan_token or check_before_sign");
    expect(skill).toContain("Checked by OddsEngine.");
    expect(skill).toContain("Removing it does not affect OddsEngine.");
    expect(read(join(dest, "AGENTS.md"))).toContain("[REDACTED:oddsengine-key]");
    expectNoLeak(allText(dest), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
    expect(treeHash(cc)).toBe(before);
  });

  it("Cursor to Claude Code: a key in the address is taken out; the plain address and Bearer ${ODDSENGINE_API_KEY} arrive", async () => {
    const cur = buildCursorOddsEngineKeyInAddress(join(src, "project"));
    const before = treeHash(cur);
    const ccHome = emptyDir(env.home, "u2c");
    const cc = emptyDir(ccHome, ".claude");
    const { plan, receipt } = await migrate({ adapter: "cursor", root: cur, nativeId: "main" }, { adapter: "claude-code", root: cc });
    expect(JSON.parse(read(join(ccHome, ".claude.json"))).mcpServers.oddsengine).toEqual({ type: "http", url: ODDSENGINE_URL, headers: { Authorization: "Bearer ${ODDSENGINE_API_KEY}" } });
    expect(notes(plan)).toContain(`The OddsEngine key was part of "oddsengine"'s address. Nomad writes the plain address and sends the key as a header instead`);
    expect(steps(plan)).toContain("ODDSENGINE_API_KEY is set");
    expect(skillDirs(join(cc, "skills"))).toEqual(["oddsengine-credit"]);
    expectNoLeak(allText(cc), read(join(ccHome, ".claude.json")), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
    expect(treeHash(cur)).toBe(before);
  });

  it("Claude Code to Cursor and OpenClaw: each app's own form, and nothing of the key in openclaw.json", async () => {
    const cc = buildClaudeCodeOddsEngine(src);
    const proj = emptyDir(env.home, "c2u");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "cursor", root: proj });
    const s = JSON.parse(read(join(proj, ".cursor/mcp.json"))).mcpServers.oddsengine;
    expect(s.url).toBe(ODDSENGINE_URL);
    expect(s.headers).toEqual({ Authorization: "Bearer ${env:ODDSENGINE_API_KEY}" });
    expectNoLeak(allText(proj));
    const oc = emptyDir(env.home, "c2o/.openclaw");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "openclaw", root: oc });
    const text = read(join(oc, "openclaw.json"));
    expect(text).not.toContain("${");
    expect(steps(plan)).toContain(`openclaw config set mcp.servers.oddsengine.headers.Authorization 'Bearer \${ODDSENGINE_API_KEY}'`);
    expect(skillDirs(join(oc, "workspace/skills"))).toContain("oddsengine-credit");
    expectNoLeak(allText(oc), JSON.stringify(plan));
  });

  it("Claude Code to Codex and back: the setup returns as it was and the skill is never doubled", async () => {
    const cc = buildClaudeCodeOddsEngine(src);
    const x = emptyDir(env.home, "rt/.codex");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: x });
    const backHome = emptyDir(env.home, "rt2");
    const back = emptyDir(backHome, ".claude");
    await migrate({ adapter: "codex", root: x, nativeId: "main" }, { adapter: "claude-code", root: back });
    expect(JSON.parse(read(join(backHome, ".claude.json"))).mcpServers.oddsengine).toEqual({ type: "http", url: ODDSENGINE_URL, headers: { Authorization: "Bearer ${ODDSENGINE_API_KEY}" } });
    expect(skillDirs(join(back, "skills")).filter((s) => s.startsWith("oddsengine-credit"))).toEqual(["oddsengine-credit"]);
  });

  it("only the components the user chose: tools alone get no credit skill", async () => {
    const cc = buildClaudeCodeOddsEngine(src);
    const dest = emptyDir(env.home, "tools-only/.codex");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest }, ["tools"]);
    expect((parseToml(read(join(dest, "config.toml"))) as any).mcp_servers.oddsengine.bearer_token_env_var).toBe("ODDSENGINE_API_KEY");
    expect(existsSync(join(dest, "skills/oddsengine-credit"))).toBe(false);
  });

  it("a .nomad package holds no key, and keeps the variable once a destination has it", async () => {
    const r = await env.nomad.readLocation("claude-code", buildClaudeCodeOddsEngine(src), "main", { register: false });
    const pkg = packAgent(r.doc);
    expectNoLeak(new TextDecoder().decode(pkg.bytes), JSON.stringify(pkg.manifest));
    const x = emptyDir(env.home, "pkg/.codex");
    await migrate({ adapter: "claude-code", root: buildClaudeCodeOddsEngine(join(src, "again")), nativeId: "main" }, { adapter: "codex", root: x });
    const fromCodex = await env.nomad.readLocation("codex", x, "main", { register: false });
    const back = unpackAgent(packAgent(fromCodex.doc).bytes);
    expect(back.ok, JSON.stringify(back.issues)).toBe(true);
    expect((back.doc!.tools.find((t) => t.name === "oddsengine")!.mcp as Record<string, unknown>).bearerEnv).toBe("ODDSENGINE_API_KEY");
  });
});

describe("OddsEngine recognition", () => {
  const remote = (url: string, headers: Record<string, unknown> = {}, enabled = true): Tool =>
    ({ name: "x", kind: "mcp", enabled, mcp: { transport: "http", url, args: [], env: {}, headers } }) as unknown as Tool;

  it("recognises OddsEngine's server, with or without a key in the address", () => {
    for (const u of [ODDSENGINE_URL, `${ODDSENGINE_URL}/`, "https://API.ODDSENGINE.live/mcp", `${ODDSENGINE_URL}/k/[REDACTED:oddsengine-key]`, ODDSENGINE_KEY_URL]) expect(knownServerId(remote(u)), u).toBe("oddsengine");
  });

  it("ignores look-alikes", () => {
    for (const u of ["http://api.oddsengine.live/mcp", "https://api.oddsengine.live.evil.example/mcp", "https://evil.example/api.oddsengine.live/mcp", "https://oddsengine.live/mcp", "https://engine.oddsengine.live/mcp", "https://api.oddsengine.live:8443/mcp", "https://user@api.oddsengine.live/mcp", "https://api.oddsengine.live/v1", "https://api.oddsengine.live/mcp/evil", "https://api.oddsengine.live/mcp/k/a/b", "http://127.0.0.1:8765/mcp"]) {
      expect(knownServerId(remote(u)), u).toBeNull();
      expect(applyKnownServerProfile(remote(u)).notes, u).toEqual([]);
    }
  });

  it("a key kept on purpose (--include-secrets) is left alone, with a warning when it is in the address", () => {
    const header = applyKnownServerProfile(remote(ODDSENGINE_URL, { Authorization: { value: `Bearer ${FAKE_ODDSENGINE_KEY}` } }), "Codex");
    expect(header.tool.mcp!.headers).toEqual({ Authorization: { value: `Bearer ${FAKE_ODDSENGINE_KEY}` } });
    expect(header.manualSteps.join("\n")).not.toContain("keys are never copied");
    const inAddress = applyKnownServerProfile(remote(ODDSENGINE_KEY_URL), "Codex");
    expect(inAddress.tool.mcp!.url).toBe(ODDSENGINE_KEY_URL);
    expect(inAddress.notes.some((n) => n.level === "warning" && n.message.includes("has its OddsEngine key in its address"))).toBe(true);
    expect(inAddress.manualSteps.join("\n")).not.toContain("has no OddsEngine API key");
  });

  it("a setup with no key gets a step with Nomad's link", () => {
    const out = applyKnownServerProfile(remote(ODDSENGINE_URL), "Codex");
    expect(out.manualSteps.join("\n")).toContain(`"x" has no OddsEngine API key here, and OddsEngine refuses calls without one. Create a key under API keys at ${ODDSENGINE_CONNECT_URL}`);
  });

  it("the credit note is added once, only for an enabled OddsEngine server", () => {
    const doc = (tools: Tool[], extra: Record<string, unknown> = {}) => ({ tools, skills: [], instructions: [], ...extra }) as never;
    const both = { skills: true, instructions: true };
    expect(oddsEngineCreditExtras(doc([remote(ODDSENGINE_URL)]), both).skills.map((s) => s.name)).toEqual(["oddsengine-credit"]);
    expect(oddsEngineCreditExtras(doc([remote(ODDSENGINE_URL)]), { skills: false, instructions: true }).instructions.map((i) => i.id)).toEqual(["oddsengine-credit"]);
    expect(oddsEngineCreditExtras(doc([remote(ODDSENGINE_URL)]), { skills: false, instructions: false })).toEqual({ skills: [], instructions: [] });
    for (const tools of [[remote(ODDSENGINE_URL, {}, false)], [remote("https://oddsengine.live/mcp")], []]) expect(oddsEngineCreditExtras(doc(tools), both)).toEqual({ skills: [], instructions: [] });
    expect(oddsEngineCreditExtras(doc([remote(ODDSENGINE_URL)], { skills: [{ name: "oddsengine-credit" }] }), both)).toEqual({ skills: [], instructions: [] });
  });

  it("finds OddsEngine keys in text and in addresses, and only the real shape", () => {
    expect(scanText(`key: ${FAKE_ODDSENGINE_KEY}`, "t").some((f) => f.ruleId === "oddsengine-key")).toBe(true);
    expect(scanText(ODDSENGINE_KEY_URL, "t").some((f) => f.ruleId === "oddsengine-key")).toBe(true);
    expect(scanText("oe_live_short", "t").some((f) => f.ruleId === "oddsengine-key")).toBe(false);
    expect(scanText("shoe_live_" + "x".repeat(30), "t").some((f) => f.ruleId === "oddsengine-key")).toBe(false);
  });

  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/oddsengine-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /oddsengine integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(text.includes(FAKE_ODDSENGINE_KEY)).toBe(false);
    expect(text).toContain(ODDSENGINE_CONNECT_URL);
  });
});
