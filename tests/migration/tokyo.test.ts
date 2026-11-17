import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import { redactText, scanText } from "@nomad/security";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_TOKYO_SECRETS, FAKE_TOKYO_TOKEN, TOKYO_HOSTED, TOKYO_TEST_HOSTED, TOKYO_URL, buildClaudeCodeTokyo, buildTokyoAgentFolder } from "../fixtures/tokyo";

/**
 * Tokyo Futuro setups (an onchain city game on Robinhood Chain) moving between platforms, and a house
 * agent exported as a folder moving into OpenClaw. The wallet key and sign-in token are fake.
 */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "tokyo");
  mkdirSync(src, { recursive: true });
});
afterEach(() => env.cleanup());

type Loc = { adapter: string; root: string; nativeId: string };

async function migrate(source: Loc, dest: { adapter: string; root: string }, opts: { includeSecrets?: boolean; runCommands?: boolean } = {}) {
  const plan = await env.nomad.plan({ source: { kind: "location", ...source }, destination: dest, includeSecrets: opts.includeSecrets });
  expect(plan.blocked).toEqual([]);
  const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true, runCommands: opts.runCommands });
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
  for (const t of texts) for (const s of FAKE_TOKYO_SECRETS) expect(t.includes(s), "a wallet key or sign-in token leaked").toBe(false);
}

const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");
const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");
const unsupported = (plan: { unsupported: Array<{ item: string; alternative?: string }> }) => plan.unsupported.map((u) => `${u.item}: ${u.alternative ?? ""}`).join("\n");

describe("Tokyo Futuro setups", () => {
  it("Claude Code to Codex: the hosted and local servers arrive; the wallet key stays", async () => {
    const cc = buildClaudeCodeTokyo(src);
    const before = treeHash(cc);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(cfg.mcp_servers["tokyo-futuro"]).toEqual({ url: TOKYO_HOSTED });
    const local = cfg.mcp_servers["tokyo-local"];
    expect(local.args).toEqual(["-y", "tokyo-futuro-mcp@0.1.2"]);
    expect(local.env).toEqual({ TOKYO_URL, AGENT_NAME: "Kestrel", AGENT_ERC8004_ID: "20708" });
    expect(local.env_vars).toEqual(["AGENT_KEY"]);
    expect(notes(plan)).toContain(`"tokyo-futuro" is Tokyo Futuro's hosted server. It needs no key and never signs anything`);
    expect(notes(plan)).toContain(`"tokyo-local" runs Tokyo Futuro's server on this computer. It uses AGENT_KEY, the agent's wallet key, only to sign Tokyo's sign-in message`);
    expect(unsupported(plan)).toContain("tokyo-local: AGENT_KEY: Set AGENT_KEY on Codex to the same wallet's key to keep playing as the same agent");
    expect(steps(plan)).toContain(`"tokyo-local" runs Tokyo Futuro's server through npx: Codex needs Node.js 20 or later`);
    expect(warnings(plan)).not.toContain("Tokyo");
    expectNoLeak(allText(dest), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
    expect(treeHash(cc)).toBe(before);
  });

  it("with --include-secrets the wallet key is still never written", async () => {
    const cc = buildClaudeCodeTokyo(src);
    const ccHome = emptyDir(env.home, "c2c");
    const dest = emptyDir(ccHome, ".claude");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "claude-code", root: dest }, { includeSecrets: true });
    const servers = JSON.parse(read(join(ccHome, ".claude.json"))).mcpServers;
    expect(servers["tokyo-local"].env.AGENT_KEY).toBe("${AGENT_KEY}");
    expect(warnings(plan)).toContain("wallet key(s) or recovery phrase(s) were left out although secrets are included");
    expectNoLeak(read(join(ccHome, ".claude.json")), allText(dest), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
  });

  it("an agent folder (persona, notes, skill and .mcp.json) moves into OpenClaw; a sign-in token in the notes is removed", async () => {
    const folder = buildTokyoAgentFolder(join(src, "diego"));
    const before = treeHash(folder);
    const oc = emptyDir(env.home, "f2o/.openclaw");
    const { plan, receipt } = await migrate({ adapter: "generic", root: folder, nativeId: "folder" }, { adapter: "openclaw", root: oc }, { runCommands: true });
    // A folder is often one someone else sent: the command OpenClaw will start is shown and needs approval.
    expect(plan.approvalsRequired).toContain("run-commands");
    expect(plan.commands).toEqual([{ tool: "tokyo-futuro", from: "folder", command: "npx -y tokyo-futuro-mcp@0.1.2", env: ["TOKYO_URL", "AGENT_KEY", "AGENT_NAME"] }]);
    expect(warnings(plan)).toContain(`"tokyo-futuro" comes from an agent folder and OpenClaw will start it by itself: npx -y tokyo-futuro-mcp@0.1.2`);
    const text = read(join(oc, "openclaw.json"));
    const cfg = JSON5.parse(text) as any;
    const server = cfg.mcp.servers["tokyo-futuro"];
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "tokyo-futuro-mcp@0.1.2"]);
    expect(server.env).toEqual({ TOKYO_URL, AGENT_NAME: "Diego Mori" });
    expect(text).not.toContain("${");
    const ws = join(oc, "workspace");
    expect(read(join(ws, "SOUL.md"))).toContain("You are Diego Mori");
    expect(read(join(ws, "AGENTS.md"))).toContain("take at most one job");
    expect(read(join(ws, "MEMORY.md"))).toContain("Stopped on auditor_not_eligible when taking job 8143");
    expect(read(join(ws, "skills/tokyo-futuro/SKILL.md"))).toContain("Never sign or send anything");
    expect(steps(plan)).toContain("AGENT_KEY");
    expectNoLeak(allText(oc), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
    expect(treeHash(folder)).toBe(before);
  });

  it("an agent folder's server is not written without approval", async () => {
    const folder = buildTokyoAgentFolder(join(src, "diego"));
    const oc = emptyDir(env.home, "f2o-no/.openclaw");
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "generic", root: folder, nativeId: "folder" }, destination: { adapter: "openclaw", root: oc } });
    expect(plan.approvalsRequired).toContain("run-commands");
    await expect(env.nomad.execute(plan.id, { broaderPermissions: true })).rejects.toThrow();
    expect(existsSync(join(oc, "openclaw.json"))).toBe(false);
  });

  it("TOKYO_URL elsewhere is a warning; the testnet, a reference or no address each get their own note", () => {
    const local = (env: Record<string, unknown>): Tool => ({ name: "t", kind: "mcp", mcp: { transport: "stdio", command: "npx", args: ["-y", "tokyo-futuro-mcp"], env, headers: {} } }) as unknown as Tool;
    const msgs = (env: Record<string, unknown>) => {
      const r = applyKnownServerProfile(local(env), "OpenClaw");
      return [...r.notes.map((n) => `${n.level}: ${n.message}`), ...r.manualSteps].join("\n");
    };
    expect(msgs({ TOKYO_URL: { value: "https://tokyo.example.org" } })).toContain(`warning: "t" signs in at https://tokyo.example.org (TOKYO_URL), not at Tokyo Futuro's own server`);
    expect(msgs({ TOKYO_URL: { value: "https://tokyofuturo-syndicates-test.gate-server.workers.dev/" } })).toContain("testnet rehearsal (chain 46630, TOKYO_URL)");
    expect(msgs({ TOKYO_URL: { value: TOKYO_URL } })).not.toContain("warning:");
    expect(msgs({ TOKYO_URL: { secretRef: "TOKYO_URL", redacted: true } })).toContain("takes Tokyo's address from TOKYO_URL, which was a variable on the source");
    expect(msgs({})).toContain(`Set TOKYO_URL for "t" on OpenClaw to ${TOKYO_URL}`);
    expect(msgs({ TOKYO_URL: { value: TOKYO_URL } })).toContain(`"t" had no AGENT_KEY, so it can read Tokyo but not sign in`);
  });

  it("the global command and the one-file script get their own install steps", () => {
    const tool = (command: string, args: string[]): Tool => ({ name: "t", kind: "mcp", mcp: { transport: "stdio", command, args, env: { TOKYO_URL: { value: TOKYO_URL } }, headers: {} } }) as unknown as Tool;
    expect(applyKnownServerProfile(tool("tokyo-futuro-mcp", []), "Hermes").manualSteps.join("\n")).toContain("npm install -g tokyo-futuro-mcp");
    expect(applyKnownServerProfile(tool("node", ["/opt/tokyo/tokyo-mcp.mjs"]), "Hermes").manualSteps.join("\n")).toContain("runs /opt/tokyo/tokyo-mcp.mjs, a file Nomad does not copy");
  });
});

describe("Tokyo Futuro recognition", () => {
  const remote = (url: string): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "http", url, args: [], env: {}, headers: {} } }) as unknown as Tool;
  const local = (command: string, args: string[] = []): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "stdio", command, args, env: {}, headers: {} } }) as unknown as Tool;

  it("recognises Tokyo's servers, package, command and script", () => {
    for (const t of [
      remote(TOKYO_HOSTED),
      remote(TOKYO_TEST_HOSTED),
      remote("https://tokyofuturo-syndicates.gate-server.workers.dev/mcp/"),
      local("npx", ["-y", "tokyo-futuro-mcp"]),
      local("npx", ["-y", "tokyo-futuro-mcp@0.1.2"]),
      local("tokyo-futuro-mcp"),
      local("C:\\Users\\a\\AppData\\Roaming\\npm\\tokyo-futuro-mcp.cmd"),
      local("node", ["tokyo-mcp.mjs"]),
      local("/usr/bin/node", ["/opt/tokyo/tokyo-mcp.mjs"])
    ]) {
      expect(knownServerId(t), JSON.stringify(t.mcp)).toBe("tokyo-futuro");
    }
  });

  it("ignores look-alikes", () => {
    for (const t of [
      remote("http://tokyofuturo-syndicates.gate-server.workers.dev/mcp"),
      remote("https://tokyofuturo-syndicates.gate-server.workers.dev.evil.example/mcp"),
      remote("https://evil.gate-server.workers.dev/mcp"),
      remote("https://tokyofuturo-syndicates-evil.gate-server.workers.dev/mcp"),
      remote("https://tokyofuturo-syndicates.gate-server.workers.dev:8443/mcp"),
      remote("https://tokyofuturo-syndicates.gate-server.workers.dev/api/mcp"),
      remote("https://tokyofuturo.xyz/mcp"),
      local("npx", ["-y", "tokyo-futuro-mcp-evil"]),
      local("npx", ["-y", "@evil/tokyo-futuro-mcp"]),
      local("node", ["tokyo-mcp.mjs.bak"]),
      local("node", ["evil-tokyo-mcp.mjs"]),
      local("bash", ["tokyo-mcp.mjs"])
    ]) {
      expect(knownServerId(t), JSON.stringify(t.mcp)).toBeNull();
    }
  });

  it("finds Tokyo's sign-in token in text, and leaves addresses and job ids alone", () => {
    expect(scanText(`token: ${FAKE_TOKYO_TOKEN}`, "t").map((f) => f.ruleId)).toContain("tokyo-futuro-token");
    // A standard base64 signature is caught whole, not cut at its first + or /.
    const b64 = "0x2d6f3da021226fc62579099d05b1a27f72484081.1795497600.3.k3J9+Q2m/7vR4tW8yZ1bC5dF6gH0jL2n=";
    expect(redactText(`token ${b64} end`).text).toBe("token [REDACTED:tokyo-futuro-token] end");
    expect(scanText("Diego's wallet is 0x2D6f3da021226fC62579099D05b1A27f72484081, job 8143.", "t")).toEqual([]);
  });

  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/tokyo-futuro-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /supports tokyo/i, /tokyo integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(/(?<!Robin)Hood Chain/.test(text)).toBe(false);
  });
});
