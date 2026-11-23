import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_IDLEX_KEY, buildClaudeCodeIdlex } from "../fixtures/idlex";

/**
 * Idlex setups (the local idlex-mcp server: AI jobs on community GPUs, paid per job in USDG on Robinhood Chain from
 * the agent's own wallet) moving between platforms. The wallet key is fake and must never be copied.
 */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "idlex");
  mkdirSync(src, { recursive: true });
});
afterEach(() => env.cleanup());

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

const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");

describe("Idlex setups", () => {
  it("Claude Code to Codex: the server and its caps arrive, the wallet key does not", async () => {
    const cc = buildClaudeCodeIdlex(src);
    const before = treeHash(src);
    const dest = emptyDir(env.home, "c2x/.codex");
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "claude-code", root: cc, nativeId: "main" }, destination: { adapter: "codex", root: dest } });
    expect(plan.blocked).toEqual([]);
    const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
    expect(receipt.status).toBe("success");
    const s = (parseToml(read(join(dest, "config.toml"))) as any).mcp_servers.idlex;
    expect(s.command).toBe("node");
    expect(s.args).toEqual([join(src, "idlex-mcp", "src", "server.ts")]);
    expect(s.env?.IDLEX_MAX_JOB_USDG).toBe("0.01");
    expect(s.env?.IDLEX_BUDGET_USDG).toBe("0.10");
    expect(notes(plan)).toContain(`"idlex" runs Idlex's server on this computer. It pays for each AI job in USDG on Robinhood Chain from the agent's own wallet (IDLEX_AGENT_KEY), only for verified jobs`);
    expect(steps(plan)).toContain("from Idlex's idlex-mcp folder, which Nomad does not copy");
    expect(steps(plan)).toContain("Node.js 22.18 or later");
    for (const t of [allText(dest), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome)]) expect(t.includes(FAKE_IDLEX_KEY.slice(2)), "the Idlex key leaked").toBe(false);
    expect(treeHash(src)).toBe(before);
  });
});

describe("Idlex recognition", () => {
  const local = (args: string[], envVars: Record<string, string> = {}, command = "node"): Tool =>
    ({ name: "idlex", kind: "mcp", mcp: { transport: "stdio", command, args, env: Object.fromEntries(Object.entries(envVars).map(([k, v]) => [k, { value: v }])), headers: {} } }) as unknown as Tool;

  it("recognises idlex-mcp's server, on any system", () => {
    for (const a of ["/home/k/idlex-mcp/src/server.ts", "C:\\Users\\k\\idlex-mcp\\src\\server.ts", "idlex-mcp/src/server.ts", "/opt/idlex-mcp-0.1.0/src/server.ts"]) expect(knownServerId(local([a])), a).toBe("idlex");
    expect(knownServerId(local(["/home/k/idlex-mcp/src/server.ts"], {}, "C:\\Program Files\\nodejs\\node.exe"))).toBe("idlex");
  });

  it("ignores look-alikes", () => {
    for (const a of ["/home/k/idlex/src/server.ts", "/home/k/idlex-mcp/src/selftest.ts", "/home/k/notidlex-mcp/src/server.ts", "/home/k/idlex-mcp/server.ts"]) {
      expect(knownServerId(local([a])), a).toBeNull();
      expect(applyKnownServerProfile(local([a])).notes, a).toEqual([]);
    }
    expect(knownServerId(local(["/home/k/idlex-mcp/src/server.ts"], {}, "bun"))).toBeNull();
  });

  it("without a key it only reads; another network address is flagged; Idlex's defaults are named", () => {
    const read = applyKnownServerProfile(local(["/k/idlex-mcp/src/server.ts"]));
    expect(read.notes.map((n) => n.message).join("\n")).toContain("without a wallet key, so it only reads");
    const other = applyKnownServerProfile(local(["/k/idlex-mcp/src/server.ts"], { IDLEX_AGENT_KEY: "x", IDLEX_API: "https://evil.example" }));
    expect(other.notes.find((n) => n.level === "warning")?.message).toContain("uses https://evil.example (IDLEX_API), not Idlex's own network");
    expect(other.notes.map((n) => n.message).join("\n")).toContain("Idlex's default applies: 0.01 USDG per job");
    const own = applyKnownServerProfile(local(["/k/idlex-mcp/src/server.ts"], { IDLEX_API: "https://www.idlex.network/" }));
    expect(own.notes.some((n) => n.level === "warning")).toBe(false);
  });

  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/idlex-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /supports idlex/i, /idlex integration/i, /—/, /idlex verified/i]) expect(re.test(text), String(re)).toBe(false);
    expect(/(?<!Robin)Hood Chain/.test(text)).toBe(false);
  });
});
