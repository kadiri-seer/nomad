import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { ROBINHOOD_BANKING_URL, ROBINHOOD_TRADING_URL, buildClaudeCodeRobinhood } from "../fixtures/robinhood";

/** Robinhood setups (its hosted Trading and Banking MCP servers, signed in by each app itself) moving between platforms. */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "robinhood");
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

describe("Robinhood setups", () => {
  it("Claude Code to Codex: both addresses arrive exactly, the sign-in is not copied, and each app signs in again", async () => {
    const cc = buildClaudeCodeRobinhood(src);
    const before = treeHash(cc);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(cfg.mcp_servers["robinhood-trading"]).toEqual({ url: ROBINHOOD_TRADING_URL });
    expect(cfg.mcp_servers["robinhood-banking"]).toEqual({ url: ROBINHOOD_BANKING_URL });
    expect(read(join(dest, "AGENTS.md"))).toContain("Ask me before every trade or purchase.");
    expect(notes(plan)).toContain(`"robinhood-trading" is Robinhood's Trading MCP, for a Robinhood Agentic account. Nomad copies only its address.`);
    expect(notes(plan)).toContain(`"robinhood-banking" is Robinhood's Banking MCP`);
    expect(warnings(plan)).toContain("place real trades in your Agentic account");
    expect(warnings(plan)).toContain("check this agent's instructions on Codex before you sign in");
    expect(warnings(plan)).toContain("Keep purchase approvals on, or monthly limits set");
    expect(steps(plan)).toContain(`Sign in to Robinhood again for "robinhood-trading" on Codex`);
    expect(steps(plan)).toContain(`Sign in to Robinhood again for "robinhood-banking" on Codex`);
    expect(treeHash(cc)).toBe(before);
  });

  it("Claude Code to Cursor: the addresses are written for Cursor", async () => {
    const cc = buildClaudeCodeRobinhood(src);
    const proj = emptyDir(env.home, "c2c/cursor-proj");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "cursor", root: proj });
    const mcp = JSON.parse(read(join(proj, ".cursor/mcp.json")));
    expect(mcp.mcpServers["robinhood-trading"].url).toBe(ROBINHOOD_TRADING_URL);
    expect(mcp.mcpServers["robinhood-banking"].url).toBe(ROBINHOOD_BANKING_URL);
    expect(steps(plan)).toContain("Tools & MCPs in Cursor");
  });
});

describe("Robinhood recognition", () => {
  const remote = (url: string): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "http", url, args: [], env: {}, headers: {} } }) as unknown as Tool;

  it("recognises Robinhood's two servers and leaves their addresses as they are", () => {
    for (const u of [ROBINHOOD_TRADING_URL, `${ROBINHOOD_TRADING_URL}/`, "https://AGENT.robinhood.com/mcp/trading"]) expect(knownServerId(remote(u)), u).toBe("robinhood-trading");
    for (const u of [ROBINHOOD_BANKING_URL, `${ROBINHOOD_BANKING_URL}/`]) expect(knownServerId(remote(u)), u).toBe("robinhood-banking");
    expect(applyKnownServerProfile(remote(ROBINHOOD_TRADING_URL)).tool.mcp!.url).toBe(ROBINHOOD_TRADING_URL);
  });

  it("ignores look-alikes", () => {
    for (const u of [
      "http://agent.robinhood.com/mcp/trading",
      "https://agent.robinhood.com.evil.example/mcp/trading",
      "https://evil.example/agent.robinhood.com/mcp/trading",
      "https://agent-robinhood.com/mcp/trading",
      "https://robinhood.com/mcp/trading",
      "https://agent.robinhood.com:8443/mcp/trading",
      "https://user@agent.robinhood.com/mcp/trading",
      "https://agent.robinhood.com/mcp/banking",
      "https://banking-agent.robinhood.com/mcp/trading",
      "https://agent.robinhood.com/mcp/trading/evil"
    ]) {
      expect(knownServerId(remote(u)), u).toBeNull();
      expect(applyKnownServerProfile(remote(u)).notes, u).toEqual([]);
    }
  });

  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/robinhood-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /supports robinhood/i, /robinhood integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(text).toContain("Robinhood has not reviewed");
  });
});
