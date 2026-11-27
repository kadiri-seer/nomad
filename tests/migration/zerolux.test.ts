import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, type Env } from "../helpers";
import { ZEROLUX_URL, buildClaudeCodeZeroLux } from "../fixtures/zerolux";

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "zerolux");
  mkdirSync(src, { recursive: true });
});
afterEach(() => env.cleanup());

describe("Zero Lux setups", () => {
  it("Claude Code to Codex: the address arrives exactly, with a note on paying", async () => {
    const cc = buildClaudeCodeZeroLux(src);
    const dest = emptyDir(env.home, "c2x/.codex");
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "claude-code", root: cc, nativeId: "main" }, destination: { adapter: "codex", root: dest } });
    expect(plan.blocked).toEqual([]);
    const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
    expect(receipt.status).toBe("success");
    expect((parseToml(read(join(dest, "config.toml"))) as any).mcp_servers.zerolux).toEqual({ url: ZEROLUX_URL });
    expect(read(join(dest, "AGENTS.md"))).toContain("Ask me before hiring any agent that costs more than 0.10 USDG.");
    const notes = plan.notes.map((n) => n.message).join("\n");
    expect(notes).toContain(`"zerolux" is Zero Lux's hosted server. It needs no key and never holds funds.`);
    expect(notes).toContain("it asks the agent's wallet to sign each USDG payment. Check this agent's instructions on Codex");
  });
});

describe("Zero Lux recognition", () => {
  const remote = (url: string): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "http", url, args: [], env: {}, headers: {} } }) as unknown as Tool;
  it("recognises Zero Lux's server and ignores look-alikes", () => {
    for (const u of [ZEROLUX_URL, "https://www.zerolux.fun/mcp", "https://zerolux.fun/mcp/"]) expect(knownServerId(remote(u)), u).toBe("zerolux");
    for (const u of ["http://zerolux.fun/mcp", "https://zerolux.fun.evil.example/mcp", "https://zerolux.fun/api/mcp", "https://zerolux.fun:8443/mcp", "https://user@zerolux.fun/mcp", "https://zer0lux.fun/mcp"]) {
      expect(knownServerId(remote(u)), u).toBeNull();
      expect(applyKnownServerProfile(remote(u)).notes, u).toEqual([]);
    }
  });
  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/zerolux-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(text).toContain("Zero Lux has not reviewed");
  });
});
