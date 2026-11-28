import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId, knownSkillNotes } from "@nomad/adapters";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_AUTONOMO_KEY, buildClaudeCodeAutonomo } from "../fixtures/autonomo";

/** Autonomo setups (its local MCP server, its spending limits and its skill) moving between platforms. */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "autonomo");
  mkdirSync(src, { recursive: true });
});
afterEach(() => env.cleanup());

async function migrate(source: { adapter: string; root: string; nativeId: string }, dest: { adapter: string; root: string }) {
  const plan = await env.nomad.plan({ source: { kind: "location", ...source }, destination: dest });
  expect(plan.blocked).toEqual([]);
  const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
  expect(receipt.status, receipt.verification.filter((v) => !v.ok).map((v) => `${v.name}: ${v.detail ?? ""}`).join("; ")).toBe("success");
  return plan;
}
const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");
const unsupported = (plan: { unsupported: Array<{ item: string; alternative?: string }> }) => plan.unsupported.map((u) => `${u.item}: ${u.alternative ?? ""}`).join("\n");
function allText(dir: string): string {
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out += statSync(p).isDirectory() ? allText(p) : readFileSync(p, "utf8");
  }
  return out;
}

describe("Autonomo setups", () => {
  it("Claude Code to Codex: the server and its limits move, the key arrives as a reference, the skill moves", async () => {
    const cc = buildClaudeCodeAutonomo(src);
    const before = treeHash(cc);
    const dest = emptyDir(env.home, "c2x/.codex");
    const plan = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const server = (parseToml(read(join(dest, "config.toml"))) as any).mcp_servers.autonomo;
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "autonomo-mcp"]);
    expect(server.env).toMatchObject({ AUTONOMO_DAILY_USDG: "0.5", AUTONOMO_MAX_USDG_PER_CALL: "0.02", AUTONOMO_PAY_WITH: "usdg" });
    expect(server.env_vars).toEqual(["AUTONOMO_WALLET_KEY"]);
    expect(allText(dest)).not.toContain(FAKE_AUTONOMO_KEY);
    expect(read(join(dest, "skills/autonomo/SKILL.md"))).toContain("Check the price before paying");
    expect(notes(plan)).toContain(`"autonomo" is Autonomo's MCP server (autonomo-mcp).`);
    expect(notes(plan)).toContain(`Spending limits for "autonomo" on Codex: 0.02 dollars a call (USDG or USDC); 0.5 dollars a day (USDG and USDC together); 5000 $AUTONOMO a call (default); 10000 $AUTONOMO a day (default). Pays with usdg.`);
    expect(notes(plan)).toContain(`The "autonomo" skill pays per call through the autonomo-sdk command`);
    expect(unsupported(plan)).toContain("autonomo: AUTONOMO_WALLET_KEY: Set AUTONOMO_WALLET_KEY on Codex yourself");
    expect(treeHash(cc)).toBe(before);
  });

  it("Claude Code to OpenClaw and to Cursor: no key is written anywhere", async () => {
    const cc = buildClaudeCodeAutonomo(src);
    const oc = emptyDir(env.home, "c2o/.openclaw");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "openclaw", root: oc });
    const s = (JSON5.parse(read(join(oc, "openclaw.json"))) as any).mcp.servers.autonomo;
    expect(s.command).toBe("npx");
    expect(JSON.stringify(s)).not.toContain(FAKE_AUTONOMO_KEY);
    expect(allText(oc)).not.toContain(FAKE_AUTONOMO_KEY);
  });

  it("with no limits set, the preview says the defaults apply", async () => {
    const cc = buildClaudeCodeAutonomo(src, { limits: false });
    const dest = emptyDir(env.home, "c2x/.codex");
    const plan = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    expect(notes(plan)).toContain("0.05 dollars a call (USDG or USDC) (default); 1 dollars a day (USDG and USDC together) (default)");
    expect(notes(plan)).toContain("Pays with auto (USDG, then $AUTONOMO, then USDC on Base), the default.");
  });

  it("a Windows entry (cmd /c npx) moves as it is, with a step for Mac and Linux", async () => {
    const cc = buildClaudeCodeAutonomo(src, { windows: true });
    const dest = emptyDir(env.home, "c2x/.codex");
    const plan = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    expect((parseToml(read(join(dest, "config.toml"))) as any).mcp_servers.autonomo.command).toBe("cmd");
    expect(steps(plan)).toContain(`"autonomo" starts through cmd /c, which only works on Windows. If Codex runs on a Mac or Linux, change it to: npx -y autonomo-mcp`);
  });
});

describe("Autonomo recognition", () => {
  const local = (command: string, args: string[], e: Record<string, unknown> = {}): Tool => ({ name: "a", kind: "mcp", mcp: { transport: "stdio", command, args, env: e, headers: {} } }) as unknown as Tool;
  it("recognises npx, cmd /c npx and the installed command; not look-alikes", () => {
    expect(knownServerId(local("npx", ["-y", "autonomo-mcp"]))).toBe("autonomo");
    expect(knownServerId(local("npx", ["-y", "autonomo-mcp@0.1.3"]))).toBe("autonomo");
    expect(knownServerId(local("cmd", ["/c", "npx", "-y", "autonomo-mcp"]))).toBe("autonomo");
    expect(knownServerId(local("autonomo-mcp", []))).toBe("autonomo");
    expect(knownServerId(local("npx", ["-y", "autonomo-mcp-evil"]))).toBeNull();
    expect(knownServerId(local("npx", ["-y", "not-autonomo-mcp"]))).toBeNull();
  });
  it("warns when it pays gateways somewhere other than autonomo.fun, and says when it has no key", () => {
    const r = applyKnownServerProfile(local("npx", ["-y", "autonomo-mcp"], { AUTONOMO_BASE_URL: { value: "https://autonomo.fun.evil.example" } }), "Codex");
    const text = r.notes.map((n) => n.message).join("\n");
    expect(text).toContain("pays the gateways at https://autonomo.fun.evil.example (AUTONOMO_BASE_URL)");
    expect(text).toContain("had no AUTONOMO_WALLET_KEY, so on Codex it finds APIs and checks prices, but cannot pay");
    const own = applyKnownServerProfile(local("npx", ["-y", "autonomo-mcp"], { AUTONOMO_BASE_URL: { value: "https://autonomo.fun" } }), "Codex");
    expect(own.notes.some((n) => n.level === "warning" && n.message.includes("AUTONOMO_BASE_URL"))).toBe(false);
  });
  it("warns about the unlimited Permit2 approval when it may pay in $AUTONOMO, not when it pays only in USDG", () => {
    const auto = applyKnownServerProfile(local("npx", ["-y", "autonomo-mcp"]), "Codex");
    expect(auto.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n")).toContain("approves Permit2 for an unlimited amount of the wallet's $AUTONOMO");
    const usdg = applyKnownServerProfile(local("npx", ["-y", "autonomo-mcp"], { AUTONOMO_PAY_WITH: { value: "usdg" } }), "Codex");
    expect(usdg.notes.some((n) => n.message.includes("Permit2"))).toBe(false);
  });
  it("only Autonomo's own skill gets the note", () => {
    expect(knownSkillNotes([{ name: "autonomo", frontmatter: { metadata: { author: "autonomo", homepage: "https://autonomo.fun" } } }], "codex", "Codex")).toHaveLength(1);
    expect(knownSkillNotes([{ name: "autonomo", frontmatter: {} }], "codex", "Codex")).toEqual([]);
  });
  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/autonomo-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(text).toContain("Autonomo has not reviewed");
  });
});
