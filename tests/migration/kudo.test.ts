import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, elizaosPluginHint, knownElizaosPlugin, knownServerId, knownSkillNotes } from "@nomad/adapters";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_KUDO_KEY, buildClaudeCodeKudo } from "../fixtures/kudo";

/** Kudo setups (its local MCP server and its skill) moving between platforms. */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "kudo");
  mkdirSync(src, { recursive: true });
});
afterEach(() => env.cleanup());

type Loc = { adapter: string; root: string; nativeId: string };

async function migrate(source: Loc, dest: { adapter: string; root: string }) {
  const plan = await env.nomad.plan({ source: { kind: "location", ...source }, destination: dest });
  expect(plan.blocked).toEqual([]);
  const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
  expect(receipt.status, receipt.verification.filter((v) => !v.ok).map((v) => `${v.name}: ${v.detail ?? ""}`).join("; ")).toBe("success");
  return plan;
}

const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");
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

describe("Kudo setups", () => {
  it("Claude Code to Codex: the server and agent id move, the key arrives as a reference, the skill moves", async () => {
    const cc = buildClaudeCodeKudo(src);
    const before = treeHash(cc);
    const dest = emptyDir(env.home, "c2x/.codex");
    const plan = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const server = (parseToml(read(join(dest, "config.toml"))) as any).mcp_servers.kudo;
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "@kudo-dev/mcp"]);
    expect(server.env).toMatchObject({ KUDO_AGENT_ID: "123" });
    expect(server.env_vars).toEqual(["KUDO_PRIVATE_KEY"]);
    expect(allText(dest)).not.toContain(FAKE_KUDO_KEY);
    expect(read(join(dest, "skills/kudo/SKILL.md"))).toContain("Register first, then mint a covenant.");
    expect(read(join(dest, "AGENTS.md"))).toContain("Never promise a payment over 5 USDG on Kudo.");
    expect(notes(plan)).toContain(`"kudo" is Kudo's MCP server (@kudo-dev/mcp).`);
    expect(warnings(plan)).toContain(`With KUDO_PRIVATE_KEY, "kudo" signs and sends Kudo transactions from the agent's wallet by itself. Covenant text is public and permanent`);
    expect(unsupported(plan)).toContain("kudo: KUDO_PRIVATE_KEY: Set KUDO_PRIVATE_KEY on Codex to the same wallet's key to keep its ERC-8004 identity (agent 123)");
    expect(notes(plan)).toContain(`The "kudo" skill signs with Foundry's cast and the PRIVATE_KEY in your shell (never copied)`);
    expect(steps(plan)).toContain(`"kudo" runs Kudo's server through npx: Codex needs Node.js on its PATH.`);
    expect(treeHash(cc)).toBe(before);
  });

  it("Claude Code to OpenClaw and to Cursor: no key is written anywhere", async () => {
    const cc = buildClaudeCodeKudo(src);
    const oc = emptyDir(env.home, "c2o/.openclaw");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "openclaw", root: oc });
    expect((JSON5.parse(read(join(oc, "openclaw.json"))) as any).mcp.servers.kudo.command).toBe("npx");
    expect(allText(oc)).not.toContain(FAKE_KUDO_KEY);
    const cur = emptyDir(env.home, "c2c/project");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "cursor", root: cur });
    expect(JSON.parse(read(join(cur, ".cursor/mcp.json"))).mcpServers.kudo.args).toEqual(["-y", "@kudo-dev/mcp"]);
    expect(allText(cur)).not.toContain(FAKE_KUDO_KEY);
  });

  it("a key from a Phala TEE (dstack) gets a warning; no key means unsigned transactions", async () => {
    const tee = buildClaudeCodeKudo(join(src, "tee"), { dstack: true });
    const plan = await migrate({ adapter: "claude-code", root: tee, nativeId: "main" }, { adapter: "codex", root: emptyDir(env.home, "t2x/.codex") });
    expect(warnings(plan)).toContain(`"kudo" takes its key from dstack inside a Phala TEE (KUDO_KEY_SOURCE=dstack). On Codex outside that enclave it has no key`);
    expect((parseToml(read(join(env.home, "t2x/.codex/config.toml"))) as any).mcp_servers.kudo.env).toMatchObject({ KUDO_KEY_SOURCE: "dstack", KUDO_AGENT_ID: "123" });
    const keyless = buildClaudeCodeKudo(join(src, "keyless"), { key: false });
    const p2 = await migrate({ adapter: "claude-code", root: keyless, nativeId: "main" }, { adapter: "codex", root: emptyDir(env.home, "k2x/.codex") });
    expect(notes(p2)).toContain(`"kudo" had no KUDO_PRIVATE_KEY, so on Codex its write tools return unsigned transactions for your own wallet to sign.`);
  });
});

describe("Kudo recognition", () => {
  const local = (command: string, args: string[], e: Record<string, unknown> = {}): Tool => ({ name: "k", kind: "mcp", mcp: { transport: "stdio", command, args, env: e, headers: {} } }) as unknown as Tool;
  it("recognises npx and the installed command; not look-alikes", () => {
    expect(knownServerId(local("npx", ["-y", "@kudo-dev/mcp"]))).toBe("kudo");
    expect(knownServerId(local("npx", ["-y", "@kudo-dev/mcp@0.1.0"]))).toBe("kudo");
    expect(knownServerId(local("kudo-mcp", []))).toBe("kudo");
    expect(knownServerId(local("npx", ["-y", "@kudo-dev/mcp-evil"]))).toBeNull();
    expect(knownServerId(local("npx", ["-y", "kudo-mcp-fake"]))).toBeNull();
    expect(knownServerId(local("npx", ["-y", "@kudo-dev/mcp", "--http"]))).toBe("kudo");
  });
  it("KUDO_KEY_SOURCE moves as a setting only when it says env or dstack", async () => {
    const { isSecretEnvEntry } = await import("@nomad/security");
    expect(isSecretEnvEntry("KUDO_KEY_SOURCE", "dstack")).toBe(false);
    expect(isSecretEnvEntry("KUDO_KEY_SOURCE", "env")).toBe(false);
    expect(isSecretEnvEntry("KUDO_KEY_SOURCE", FAKE_KUDO_KEY)).toBe(true);
    expect(isSecretEnvEntry("KUDO_KEY_SOURCE", "/home/me/key.txt")).toBe(true);
    expect(isSecretEnvEntry("KUDO_PRIVATE_KEY", "dstack")).toBe(true);
  });
  it("warns about an RPC other than Robinhood Chain's public one", () => {
    const r = applyKnownServerProfile(local("npx", ["-y", "@kudo-dev/mcp"], { KUDO_RPC_URL: { value: "https://rpc.example.com/v2/secretpath" } }), "Codex");
    const text = r.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");
    expect(text).toContain("reads Robinhood Chain through https://rpc.example.com (KUDO_RPC_URL)");
    expect(text).not.toContain("secretpath");
    const own = applyKnownServerProfile(local("npx", ["-y", "@kudo-dev/mcp"], { KUDO_RPC_URL: { value: "https://rpc.mainnet.chain.robinhood.com" } }), "Codex");
    expect(own.notes.some((n) => n.level === "warning")).toBe(false);
  });
  it("only Kudo's own skill gets the note", () => {
    expect(knownSkillNotes([{ name: "kudo", frontmatter: { description: "Make and keep promises with other AI agents as Kudo covenants on Robinhood Chain, using cast." } }], "codex", "Codex")).toHaveLength(1);
    expect(knownSkillNotes([{ name: "kudo", frontmatter: { description: "Praise teammates." } }], "codex", "Codex")).toEqual([]);
  });
  it("knows Kudo's ElizaOS plugin and its key settings", () => {
    const p = knownElizaosPlugin("@kudo-dev/plugin-kudo");
    expect(p?.sensitive).toContain("KUDO_PRIVATE_KEY");
    expect(elizaosPluginHint("@kudo-dev/plugin-kudo")).toBe("On this platform, use the local MCP server kudo (npx -y @kudo-dev/mcp). Nomad does not add it for you (the key stays with you).");
  });
  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/kudo-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /supports kudo/i, /kudo integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(text).toContain("Kudo has not reviewed");
  });
});
