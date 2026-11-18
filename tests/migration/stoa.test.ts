import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { STOA_URL, buildClaudeCodeStoa } from "../fixtures/stoa";

/** Stoa setups (a hosted, keyless swap router whose unsigned swaps the user's wallet signs) moving between platforms. */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "stoa");
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

describe("Stoa setups", () => {
  it("Claude Code to Codex: the address and the stoa skill arrive as they are, with the router to check", async () => {
    const cc = buildClaudeCodeStoa(src);
    const before = treeHash(cc);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(cfg.mcp_servers.stoa).toEqual({ url: STOA_URL });
    expect(read(join(dest, "skills/stoa/SKILL.md"))).toContain("Run safety_check on unfamiliar tokens");
    expect(notes(plan)).toContain(`"stoa" is Stoa's hosted swap router. It needs no key and never signs or sends anything`);
    expect(notes(plan)).toContain("0x2F2804fad735a38015650f32f95Ad5E08D6B3eE5 on Robinhood Chain (4663), 0x104752D50ef893da579Ad813918269e09Ea17dbA on Elysium (99901)");
    expect(warnings(plan)).not.toContain("Stoa");
    expect(treeHash(cc)).toBe(before);
  });

  it("Claude Code to OpenClaw: the address is unchanged (no referral is added)", async () => {
    const cc = buildClaudeCodeStoa(src);
    const oc = emptyDir(env.home, "c2o/.openclaw");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "openclaw", root: oc });
    expect((JSON5.parse(read(join(oc, "openclaw.json"))) as any).mcp.servers.stoa).toEqual({ url: STOA_URL, transport: "streamable-http" });
    expect(read(join(oc, "workspace/skills/stoa/SKILL.md"))).toContain("Confirm tx.to is the Stoa router");
  });
});

describe("Stoa recognition", () => {
  const remote = (url: string): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "http", url, args: [], env: {}, headers: {} } }) as unknown as Tool;

  it("recognises Stoa's server", () => {
    for (const u of [STOA_URL, "https://stoadex.com/mcp/", "https://STOADEX.com/mcp"]) expect(knownServerId(remote(u)), u).toBe("stoa");
    expect(applyKnownServerProfile(remote(STOA_URL)).tool.mcp!.url).toBe(STOA_URL);
  });

  it("ignores look-alikes", () => {
    for (const u of ["http://stoadex.com/mcp", "https://stoadex.com.evil.example/mcp", "https://evil.example/stoadex.com/mcp", "https://www.stoadex.com/mcp", "https://stoadex.co/mcp", "https://stoadex.com:8443/mcp", "https://user@stoadex.com/mcp", "https://stoadex.com/api/v1", "https://stoadex.com/mcp/evil"]) {
      expect(knownServerId(remote(u)), u).toBeNull();
      expect(applyKnownServerProfile(remote(u)).notes, u).toEqual([]);
    }
  });

  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/stoa-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /supports stoa/i, /stoa integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(/(?<!Robin)Hood Chain/.test(text)).toBe(false);
  });
});
