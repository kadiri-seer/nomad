import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_HEY_SECRETS, HEY_RESEARCH_URL, HEY_URL, buildClaudeCodeHey, buildCodexHey, buildGeminiHey, buildHermesHey, buildOpenClawHey } from "../fixtures/hey";

/**
 * HEY Research Lab setups (read-only research on Robinhood Chain projects) moving between platforms.
 * Fixtures follow what HEY documents; keys are fake.
 */

let env: Env;
let hey: string;
beforeEach(() => {
  env = setup();
  hey = join(env.home, "hey");
  mkdirSync(hey, { recursive: true });
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
  for (const t of texts) for (const s of FAKE_HEY_SECRETS) expect(t.includes(s), "an API key leaked").toBe(false);
}

const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");
const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");

describe("HEY Research setups", () => {
  it("Claude Code to Codex: hosted servers and the local server arrive; keys stay", async () => {
    const src = buildClaudeCodeHey(hey);
    const before = treeHash(src);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(cfg.mcp_servers["hey-research"]).toEqual({ url: HEY_URL });
    const research = cfg.mcp_servers["hey-research-research"];
    expect(research.url).toBe(HEY_RESEARCH_URL);
    // The self-declared integration name is not a secret and carries over; the key is forwarded, never written.
    expect(research.http_headers).toEqual({ "x-hey-integration": "kestrel/1.0" });
    // The held-back key is read alone from HEY_API_KEY, not from a variable named after the header.
    expect(research.bearer_token_env_var).toBe("HEY_API_KEY");
    expect(research.env_http_headers).toBeUndefined();
    const local = cfg.mcp_servers["hey-local"];
    expect(local.command).toBe("npx");
    expect(local.args).toEqual(["-y", "@hey-research-lab/mcp@0.3.5"]);
    expect(local.env).toEqual({ HEY_MCP_PROFILE: "research" });
    expect(local.env_vars).toEqual(["HEY_API_KEY"]);
    expect(notes(plan)).toContain(`"hey-research" is HEY Research Lab's hosted, read-only server. It needs no key and no wallet`);
    expect(notes(plan)).toContain(`"hey-research-research" is HEY Research Lab's hosted, read-only server (the research profile`);
    expect(notes(plan)).toContain(`"hey-research-research" used a HEY API key (hey_...). Keys are never copied: on Codex, set HEY_API_KEY to the key alone`);
    expect(notes(plan)).toContain(`"hey-local" used a HEY API key (HEY_API_KEY). Keys are never copied`);
    expect(notes(plan)).toContain(`"hey-local" serves HEY's research profile (HEY_MCP_PROFILE=research)`);
    expect(steps(plan)).toContain(`"hey-local" runs HEY Research Lab's server through npx: Codex needs Node.js 20 or later`);
    expect(warnings(plan)).not.toContain("HEY");
    expectNoLeak(allText(dest), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
    expect(treeHash(src)).toBe(before);
  });

  it("Codex to OpenClaw: an address other than heyresearch.xyz is flagged, and the file stays valid for OpenClaw", async () => {
    const src = buildCodexHey(hey);
    const dest = emptyDir(env.home, "x2o/.openclaw");
    const { plan } = await migrate({ adapter: "codex", root: src, nativeId: "main" }, { adapter: "openclaw", root: dest });
    const text = read(join(dest, "openclaw.json"));
    const cfg = JSON5.parse(text) as any;
    expect(cfg.mcp.servers["hey-research"]).toEqual({ url: HEY_URL, transport: "streamable-http" });
    expect(cfg.mcp.servers["hey-local"].args).toEqual(["-y", "@hey-research-lab/mcp@0.3.5"]);
    expect(cfg.mcp.servers["hey-local"].env).toEqual({ HEY_API_URL: "https://hey.example.org", HEY_MARKET_INTEGRITY: "public" });
    expect(text).not.toContain("${");
    expect(warnings(plan)).toContain(`"hey-local" reads https://hey.example.org instead of https://heyresearch.xyz (HEY_API_URL). Its API key, if it has one, is sent there too.`);
  });

  it("Gemini CLI to Claude Code: the global command gets an install step", async () => {
    const src = buildGeminiHey(hey);
    const destHome = emptyDir(env.home, "g2c");
    const dest = emptyDir(destHome, ".claude");
    const { plan } = await migrate({ adapter: "gemini-cli", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest });
    const servers = JSON.parse(read(join(destHome, ".claude.json"))).mcpServers;
    expect(servers["hey-research"]).toMatchObject({ type: "http", url: HEY_URL });
    expect(servers["hey-local"]).toMatchObject({ command: "hey-research-mcp" });
    expect(steps(plan)).toContain("npm install -g @hey-research-lab/mcp. It needs Node.js 20 or later, and the hey-research-mcp command must be on the PATH Claude Code uses.");
  });

  it("Hermes to Gemini CLI: the key and address were references, and the research profile arrives as Gemini's own form", async () => {
    const src = buildHermesHey(hey);
    const dest = emptyDir(env.home, "h2g/.gemini");
    const { plan, receipt } = await migrate({ adapter: "hermes", root: src, nativeId: "main" }, { adapter: "gemini-cli", root: dest });
    const servers = JSON.parse(read(join(dest, "settings.json"))).mcpServers;
    expect(servers["hey-research"].httpUrl).toBe(HEY_RESEARCH_URL);
    expect(servers["hey-local"].args).toEqual(["-y", "@hey-research-lab/mcp"]);
    expect(notes(plan)).toContain(`"hey-local" takes the HEY address it reads from HEY_API_URL, which was a variable on the source. Without it on Gemini CLI, it reads https://heyresearch.xyz.`);
    expect(steps(plan)).toContain("HEY_API_KEY");
    expectNoLeak(allText(dest), JSON.stringify(plan), JSON.stringify(receipt));
  });

  it("OpenClaw to Claude Code and back: the hosted server survives the round trip", async () => {
    const src = buildOpenClawHey(hey);
    const ccHome = emptyDir(env.home, "o2c");
    const cc = emptyDir(ccHome, ".claude");
    await migrate({ adapter: "openclaw", root: src, nativeId: "main" }, { adapter: "claude-code", root: cc });
    expect(JSON.parse(read(join(ccHome, ".claude.json"))).mcpServers["hey-research"]).toMatchObject({ type: "http", url: HEY_URL });
    const back = emptyDir(env.home, "c2o/.openclaw");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "openclaw", root: back });
    expect((JSON5.parse(read(join(back, "openclaw.json"))) as any).mcp.servers["hey-research"]).toEqual({ url: HEY_URL, transport: "streamable-http" });
  });
});

describe("HEY Research recognition", () => {
  const remote = (url: string): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "http", url, args: [], env: {}, headers: {} } }) as unknown as Tool;
  const local = (command: string, args: string[] = []): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "stdio", command, args, env: {}, headers: {} } }) as unknown as Tool;

  it("recognises HEY's real servers and package", () => {
    for (const t of [
      remote("https://heyresearch.xyz/mcp"),
      remote("https://heyresearch.xyz/mcp/"),
      remote("https://heyresearch.xyz/mcp/research"),
      local("npx", ["-y", "@hey-research-lab/mcp"]),
      local("npx", ["-y", "@hey-research-lab/mcp@0.3.5"]),
      local("npx", ["-y", "@hey-research-lab/mcp@latest"]),
      local("hey-research-mcp"),
      local("/usr/local/bin/hey-research-mcp"),
      local("C:\\Users\\a\\AppData\\Roaming\\npm\\hey-research-mcp.cmd")
    ]) {
      expect(knownServerId(t), JSON.stringify(t.mcp)).toBe("hey-research");
    }
  });

  it("ignores look-alikes", () => {
    for (const t of [
      remote("https://heyresearch.xyz.evil.example/mcp"),
      remote("https://evil.example/heyresearch.xyz/mcp"),
      remote("http://heyresearch.xyz/mcp"),
      remote("https://heyresearch.xyz:8443/mcp"),
      remote("https://heyresearch.xyz/mcp/other"),
      remote("https://api.heyresearch.xyz/mcp"),
      remote("not a url"),
      local("npx", ["-y", "@hey-research-lab/mcp-tools"]),
      local("npx", ["-y", "x@hey-research-lab/mcp"]),
      local("npx", ["-y", "@hey-research-lab/mcp@https://evil.example/pkg.tgz"]),
      local("hey-research-mcp-fake"),
      local("not-hey-research-mcp")
    ]) {
      expect(knownServerId(t), JSON.stringify(t.mcp)).toBeNull();
    }
  });

  it("a look-alike address never gets HEY's reassuring notes", () => {
    const out = applyKnownServerProfile(remote("https://heyresearch.xyz.evil.example/mcp"), "Codex");
    expect(out.notes).toEqual([]);
  });
});

describe("HEY Research wording", () => {
  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/hey-research-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner\b/i, /airdrop/i, /token launch/i, /supports hey/i, /hey integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(/(?<!Robin)Hood Chain/.test(text)).toBe(false);
  });
});
