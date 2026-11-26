import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { BULL_URL, FAKE_BULL_KEY, buildClaudeCodeBull } from "../fixtures/bull";

/** Bull setups (its hosted planning server and its local signing server) moving between platforms. */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "bull");
  mkdirSync(src, { recursive: true });
});
afterEach(() => env.cleanup());

type Loc = { adapter: string; root: string; nativeId: string };

async function migrate(source: Loc, dest: { adapter: string; root: string }) {
  const plan = await env.nomad.plan({ source: { kind: "location", ...source }, destination: dest });
  expect(plan.blocked).toEqual([]);
  const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
  expect(receipt.status, receipt.verification.filter((v) => !v.ok).map((v) => `${v.name}: ${v.detail ?? ""}`).join("; ")).toBe("success");
  return { plan, receipt };
}

const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");
const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");

function allText(dir: string): string {
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out += statSync(p).isDirectory() ? allText(p) : readFileSync(p, "utf8");
  }
  return out;
}

describe("Bull setups", () => {
  it("Claude Code to Codex: the hosted address arrives exactly, the local server arrives without its key", async () => {
    const cc = buildClaudeCodeBull(src);
    const before = treeHash(cc);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(cfg.mcp_servers.bull).toEqual({ url: BULL_URL });
    expect(cfg.mcp_servers["bull-local"].command).toBe("node");
    expect(cfg.mcp_servers["bull-local"].args).toEqual(["/home/me/bull/bull-mcp.mjs"]);
    expect(allText(dest)).not.toContain(FAKE_BULL_KEY);
    expect(read(join(dest, "AGENTS.md"))).toContain("Check a counterparty's Bull record before any deal over 50 USDG.");
    expect(notes(plan)).toContain(`"bull" is Bull's hosted server. It needs no key and never sends anything`);
    expect(warnings(plan)).toContain(`"bull-local" runs Bull's server on this computer. With BULL_AGENT_KEY it signs and sends escrow transactions`);
    expect(steps(plan)).toContain(`"bull-local" runs /home/me/bull/bull-mcp.mjs, a file Nomad does not copy.`);
    expect(treeHash(cc)).toBe(before);
  });

  it("Claude Code to OpenClaw: the address arrives as a streamable server, and no key is written", async () => {
    const cc = buildClaudeCodeBull(src);
    const oc = emptyDir(env.home, "c2o/.openclaw");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "openclaw", root: oc });
    expect((JSON5.parse(read(join(oc, "openclaw.json"))) as any).mcp.servers.bull).toEqual({ url: BULL_URL, transport: "streamable-http" });
    expect(allText(oc)).not.toContain(FAKE_BULL_KEY);
    expect(notes(plan)).toContain("Bull says its contracts are not audited yet");
  });
});

describe("Bull recognition", () => {
  const remote = (url: string): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "http", url, args: [], env: {}, headers: {} } }) as unknown as Tool;
  const local = (command: string, args: string[], env: Record<string, unknown> = {}): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "stdio", command, args, env, headers: {} } }) as unknown as Tool;

  it("recognises Bull's hosted server and its local file", () => {
    for (const u of [BULL_URL, "https://bull.family/api/mcp", "https://www.bull.family/api/mcp/"]) expect(knownServerId(remote(u)), u).toBe("bull");
    for (const a of ["bull-mcp.mjs", "./bull-mcp.mjs", "C:\\Users\\me\\bull\\bull-mcp.mjs"]) expect(knownServerId(local("node", [a])), a).toBe("bull");
    expect(applyKnownServerProfile(remote(BULL_URL)).tool.mcp!.url).toBe(BULL_URL);
  });

  it("says when the local server has no key, so it can only plan", () => {
    const r = applyKnownServerProfile(local("node", ["bull-mcp.mjs"]), "Codex");
    expect(r.notes.map((n) => n.message).join("\n")).toContain("had no BULL_AGENT_KEY, so on Codex it can plan and read but not send");
    expect(r.unsupported).toEqual([]);
  });

  it("ignores look-alikes", () => {
    for (const u of [
      "http://www.bull.family/api/mcp",
      "https://www.bull.family.evil.example/api/mcp",
      "https://evil.example/www.bull.family/api/mcp",
      "https://www.bull.family/mcp",
      "https://www.bull.family:8443/api/mcp",
      "https://user@www.bull.family/api/mcp",
      "https://bull.fam1ly/api/mcp"
    ]) {
      expect(knownServerId(remote(u)), u).toBeNull();
      expect(applyKnownServerProfile(remote(u)).notes, u).toEqual([]);
    }
    for (const a of ["bull-mcp.mjs.bak", "my-bull-mcp.mjs.js", "notbull-mcp.js"]) expect(knownServerId(local("node", [a])), a).toBeNull();
    expect(knownServerId(local("python", ["bull-mcp.mjs"]))).toBeNull();
  });

  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/bull-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /supports bull/i, /bull integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(text).toContain("Bull has not reviewed");
  });
});
