import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId, knownSkillNotes } from "@nomad/adapters";
import { isSensitiveFile } from "@nomad/security";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_LITE_KEY, FAKE_SESSION, VIRTUALS_URL, buildClaudeCodeVirtuals } from "../fixtures/virtuals";

/** Virtuals setups (its hosted agent server and its acp skills) moving between platforms. */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "virtuals");
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

/** Every file below a folder, read as text, so a test can check nothing anywhere holds a value. */
function allText(dir: string): string {
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out += statSync(p).isDirectory() ? allText(p) : readFileSync(p, "utf8");
  }
  return out;
}

describe("Virtuals setups", () => {
  it("Claude Code to Codex: the server address arrives exactly and each app signs in again", async () => {
    const cc = buildClaudeCodeVirtuals(src);
    const before = treeHash(cc);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(cfg.mcp_servers.virtuals).toEqual({ url: VIRTUALS_URL });
    expect(read(join(dest, "AGENTS.md"))).toContain("Ask me before paying for anything or hiring an agent.");
    expect(notes(plan)).toContain(`"virtuals" is Virtuals' hosted server for its agents. Nomad copies only its address.`);
    expect(warnings(plan)).toContain(`"virtuals" lets the agent issue payment cards and set their limits, and read and send its email. Check this agent's instructions on Codex before it signs in.`);
    expect(steps(plan)).toContain(`Sign in to Virtuals again for "virtuals" on Codex`);
    expect(treeHash(cc)).toBe(before);
  });

  it("the acp-cli skill moves, with a warning that this computer's acp sign-in works there at once", async () => {
    const cc = buildClaudeCodeVirtuals(src);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    expect(read(join(dest, "skills/acp-cli/SKILL.md"))).toContain("Authenticate with acp configure start");
    expect(warnings(plan)).toContain(`The "acp-cli" skill runs Virtuals' acp command. Its sign-in and signing key stay in this computer's keychain and are never copied.`);
    expect(warnings(plan)).toContain("including sending from the agent's wallet, trading and paying with its card, within the signer's policy");
  });

  it("the deprecated virtuals-protocol-acp skill moves without its config.json, which holds its key and session", async () => {
    const cc = buildClaudeCodeVirtuals(src);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const skill = join(dest, "skills/virtuals-protocol-acp");
    expect(read(join(skill, "references/acp-job.md"))).toContain("acp job create");
    expect(existsSync(join(skill, "config.json"))).toBe(false);
    expect(allText(dest)).not.toContain(FAKE_LITE_KEY);
    expect(allText(dest)).not.toContain(FAKE_SESSION);
    expect(warnings(plan)).toContain("Skipped config.json in skill virtuals-protocol-acp: it holds the skill's key (LITE_AGENT_API_KEY). Keys are never copied.");
    expect(warnings(plan)).toContain(`The "virtuals-protocol-acp" skill is deprecated`);
  });

  it("Claude Code to OpenClaw: the address arrives as a streamable server, and no key is written", async () => {
    const cc = buildClaudeCodeVirtuals(src);
    const oc = emptyDir(env.home, "c2o/.openclaw");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "openclaw", root: oc });
    expect((JSON5.parse(read(join(oc, "openclaw.json"))) as any).mcp.servers.virtuals).toEqual({ url: VIRTUALS_URL, transport: "streamable-http" });
    expect(existsSync(join(oc, "workspace/skills/virtuals-protocol-acp/config.json"))).toBe(false);
    expect(allText(oc)).not.toContain(FAKE_LITE_KEY);
    expect(steps(plan)).toContain(`Sign in to Virtuals again for "virtuals" on OpenClaw`);
  });
});

describe("Virtuals recognition", () => {
  const remote = (url: string): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "http", url, args: [], env: {}, headers: {} } }) as unknown as Tool;

  it("recognises Virtuals' server, with or without the trailing slash", () => {
    for (const u of [VIRTUALS_URL, "https://mcp.acp.virtuals.io", "https://MCP.acp.virtuals.io/"]) expect(knownServerId(remote(u)), u).toBe("virtuals");
    expect(applyKnownServerProfile(remote(VIRTUALS_URL)).tool.mcp!.url).toBe(VIRTUALS_URL);
  });

  it("ignores look-alikes", () => {
    for (const u of [
      "http://mcp.acp.virtuals.io/",
      "https://mcp.acp.virtuals.io.evil.example/",
      "https://evil.example/mcp.acp.virtuals.io/",
      "https://acp.virtuals.io/",
      "https://mcp-acp.virtuals.io/",
      "https://mcp.acp.virtuals.io:8443/",
      "https://user@mcp.acp.virtuals.io/",
      "https://mcp.acp.virtuals.io/mcp",
      "https://mcp.base.org"
    ]) {
      expect(knownServerId(remote(u)), u).toBeNull();
      expect(applyKnownServerProfile(remote(u)).notes, u).toEqual([]);
    }
  });

  it("only Virtuals' own skills get the notes", () => {
    const skill = (name: string, metadata?: unknown) => ({ name, frontmatter: metadata ? { metadata } : {} });
    expect(knownSkillNotes([skill("acp-cli", { acpCliVersion: "1.0.28" })], "codex", "Codex")).toHaveLength(1);
    expect(knownSkillNotes([skill("virtuals-protocol-acp", { openclaw: { primaryEnv: "LITE_AGENT_API_KEY" } })], "codex", "Codex")).toHaveLength(1);
    // Same names without Virtuals' own markers are someone else's skills.
    expect(knownSkillNotes([skill("acp-cli"), skill("virtuals-protocol-acp")], "codex", "Codex")).toEqual([]);
  });

  it("the acp CLI's account folder is never read as part of an agent", () => {
    expect(isSensitiveFile(".config/acp/config.json")).toBe(true);
    expect(isSensitiveFile("home/.config/acp/config-testnet.json")).toBe(true);
    expect(isSensitiveFile(".local/share/keyring/secrets.json")).toBe(true);
  });

  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/virtuals-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /supports virtuals/i, /virtuals integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(text).toContain("Virtuals has not reviewed");
  });
});
