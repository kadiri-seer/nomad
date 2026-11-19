import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_UPOCH_ENCRYPTION_KEY, FAKE_UPOCH_OWNER_KEY, buildClaudeCodeUpoch, buildCodexUpoch, plantUpochHome } from "../fixtures/upoch";

/**
 * Upoch Guard setups (the local `upoch mcp` server: checkpoints and recovery on Robinhood Chain, keys in
 * ~/.upoch) moving between platforms. The keys folder is never read; the planted keys are fake.
 */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "upoch");
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
  for (const t of texts) for (const s of [FAKE_UPOCH_OWNER_KEY, FAKE_UPOCH_ENCRYPTION_KEY]) expect(t.includes(s), "an Upoch key leaked").toBe(false);
}

const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");
const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");

describe("Upoch setups", () => {
  it("Claude Code to Codex: `upoch mcp` arrives as written, ~/.upoch is never read, and the preview says one app at a time", async () => {
    const cc = buildClaudeCodeUpoch(src);
    plantUpochHome(src);
    const before = treeHash(src);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(cfg.mcp_servers.upoch).toEqual({ command: "upoch", args: ["mcp"] });
    expect(notes(plan)).toContain(`"upoch" runs Upoch Guard on this computer: it checkpoints the agent's work on Robinhood Chain and can restore or roll it back. Its keys and settings stay in ~/.upoch; Nomad never reads, copies or moves that folder.`);
    expect(warnings(plan)).toContain(`Upoch does not coordinate two copies of the same agent yet. Stop "upoch" in the app you moved it from before Codex starts it.`);
    expect(notes(plan)).toContain("no independent audit yet");
    expect(notes(plan)).toContain(`Risk Check (spending limits) runs through Upoch's SDK, not through "upoch".`);
    expect(steps(plan)).toContain(`If Codex runs on another computer, copy ~/.upoch there yourself (keep it readable only by you) before Codex first starts "upoch": that folder carries the agent's Upoch keys.`);
    expect(steps(plan)).toContain(`Install Upoch Guard for "upoch": npm install -g @upoch/guard. It needs Node.js 24 or later`);
    expectNoLeak(allText(dest), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
    expect(treeHash(src)).toBe(before);
  });

  it("Codex to OpenClaw: the npx form and UPOCH_HOME carry over, and the preview names that folder", async () => {
    const cx = buildCodexUpoch(src);
    const before = treeHash(cx);
    const oc = emptyDir(env.home, "x2o/.openclaw");
    const { plan } = await migrate({ adapter: "codex", root: cx, nativeId: "main" }, { adapter: "openclaw", root: oc });
    const s = (JSON5.parse(read(join(oc, "openclaw.json"))) as any).mcp.servers.upoch;
    expect(s.command).toBe("npx");
    expect(s.args).toEqual(["-y", "@upoch/guard@0.1.4", "mcp"]);
    expect(s.env).toEqual({ UPOCH_HOME: "/home/kestrel/agents/upoch" });
    expect(notes(plan)).toContain("Its keys and settings stay in /home/kestrel/agents/upoch");
    expect(steps(plan)).toContain(`"upoch" runs Upoch Guard through npx: OpenClaw needs Node.js 24 or later on its PATH.`);
    expect(warnings(plan)).toContain("Stop \"upoch\" in the app you moved it from before OpenClaw starts it.");
    expect(treeHash(cx)).toBe(before);
  });

  it("Claude Code to Codex and back: the entry comes back as it was", async () => {
    const cc = buildClaudeCodeUpoch(src);
    const cx = emptyDir(env.home, "rt/.codex");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: cx });
    const back = emptyDir(env.home, "rt2/.claude");
    await migrate({ adapter: "codex", root: cx, nativeId: "main" }, { adapter: "claude-code", root: back });
    expect(JSON.parse(read(join(env.home, "rt2/.claude.json"))).mcpServers.upoch).toMatchObject({ command: "upoch", args: ["mcp"] });
  });
});

describe("Upoch recognition", () => {
  const local = (command: string, args: string[]): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "stdio", command, args, env: {}, headers: {} } }) as unknown as Tool;

  it("recognises Upoch Guard's server", () => {
    for (const [c, a] of [["upoch", ["mcp"]], ["/usr/local/bin/upoch", ["mcp"]], ["C:\\Users\\k\\AppData\\Roaming\\npm\\upoch.cmd", ["mcp"]], ["npx", ["-y", "@upoch/guard", "mcp"]], ["npx", ["@upoch/guard@0.1.4", "mcp"]]] as Array<[string, string[]]>) {
      expect(knownServerId(local(c, a)), `${c} ${a.join(" ")}`).toBe("upoch");
    }
  });

  it("ignores look-alikes and the other upoch commands", () => {
    for (const [c, a] of [["upoch", ["setup"]], ["upoch", []], ["upoch", ["mcp", "--evil"]], ["upoch-evil", ["mcp"]], ["notupoch", ["mcp"]], ["npx", ["-y", "@upoch/guard-evil", "mcp"]], ["npx", ["-y", "upoch", "mcp"]], ["npx", ["-y", "@evil/guard", "mcp"]], ["npx", ["-y", "@upoch/guard", "setup"]], ["npx", ["-y", "@upoch/sdk", "mcp"]]] as Array<[string, string[]]>) {
      expect(knownServerId(local(c, a)), `${c} ${a.join(" ")}`).toBeNull();
      expect(applyKnownServerProfile(local(c, a)).notes, `${c} ${a.join(" ")}`).toEqual([]);
    }
  });

  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/upoch-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /supports upoch/i, /upoch integration/i, /—/, /upoch verified/i]) expect(re.test(text), String(re)).toBe(false);
    expect(/(?<!Robin)Hood Chain/.test(text)).toBe(false);
  });
});
