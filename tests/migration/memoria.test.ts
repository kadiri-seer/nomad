import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import { packAgent, unpackAgent } from "@nomad/archive";
import { scanText } from "@nomad/security";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_MEMORIA_KEY, FAKE_MEMORIA_SECRETS, MEMORIA_URL, buildClaudeCodeMemoria, buildCodexMemoria, buildCursorMemoria, buildHermesMemoria } from "../fixtures/memoria";

/**
 * Memoria setups (a hosted, shared memory server for AI agents; every request needs the agent's
 * "Authorization: Bearer mem_..." key, which is also the agent's identity) moving between platforms. Keys are fake.
 */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "memoria");
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
  for (const t of texts) for (const s of FAKE_MEMORIA_SECRETS) expect(t.includes(s), "a Memoria key leaked").toBe(false);
}

const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");
const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");
const ABOUT = `"memoria" is Memoria's hosted memory server. Memories stay on Memoria's server and nothing about them is copied; Nomad copies its address.`;

describe("Memoria setups", () => {
  it("Claude Code to Codex: the key in the header becomes bearer_token_env_var = MEMORIA_API_KEY, and is never written", async () => {
    const cc = buildClaudeCodeMemoria(src);
    const before = treeHash(cc);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(cfg.mcp_servers.memoria).toEqual({ url: MEMORIA_URL, bearer_token_env_var: "MEMORIA_API_KEY" });
    expect(notes(plan)).toContain(ABOUT);
    expect(notes(plan)).toContain("with the same key this agent keeps reading and saving the same memories on Codex");
    expect(steps(plan)).toContain(`The "memoria" key is this agent's Memoria API key (mem_..., shown once at sign-up); keys are never copied. Memoria refuses every request without a valid key, so the server does not work on Codex until MEMORIA_API_KEY is set. Use the same key to stay the same agent.`);
    expect(steps(plan)).toContain(`Set MEMORIA_API_KEY in your shell to the key alone before starting Codex: the "memoria" MCP server sends it as a bearer token (bearer_token_env_var).`);
    expect(warnings(plan)).not.toContain("Memoria");
    expect(read(join(dest, "AGENTS.md"))).toContain("[REDACTED:memoria-key]");
    expectNoLeak(allText(dest), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
    expect(treeHash(cc)).toBe(before);
  });

  it("Codex to Claude Code: bearer_token_env_var arrives as \"Bearer ${MEMORIA_API_KEY}\"", async () => {
    const cx = buildCodexMemoria(src);
    const before = treeHash(cx);
    const dest = emptyDir(env.home, "x2c/.claude");
    const { plan } = await migrate({ adapter: "codex", root: cx, nativeId: "main" }, { adapter: "claude-code", root: dest });
    expect(JSON.parse(read(join(env.home, "x2c/.claude.json"))).mcpServers.memoria).toEqual({ type: "http", url: MEMORIA_URL, headers: { Authorization: "Bearer ${MEMORIA_API_KEY}" } });
    expect(steps(plan)).toContain(`Set MEMORIA_API_KEY in your environment to the key alone, so the "memoria" MCP server can authenticate in Claude Code`);
    expect(treeHash(cx)).toBe(before);
  });

  it("Codex to Claude Code and back: the setup comes back as it was", async () => {
    const cx = buildCodexMemoria(src);
    const cc = emptyDir(env.home, "rt/.claude");
    await migrate({ adapter: "codex", root: cx, nativeId: "main" }, { adapter: "claude-code", root: cc });
    const back = emptyDir(env.home, "rt2/.codex");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: back });
    expect((parseToml(read(join(back, "config.toml"))) as any).mcp_servers.memoria).toEqual({ url: MEMORIA_URL, bearer_token_env_var: "MEMORIA_API_KEY" });
  });

  it("Codex to Hermes: the header uses ${MEMORIA_API_KEY}, and the steps say where to put it", async () => {
    const cx = buildCodexMemoria(src);
    const dest = emptyDir(env.home, "x2h/.hermes");
    const { plan } = await migrate({ adapter: "codex", root: cx, nativeId: "main" }, { adapter: "hermes", root: dest });
    expect(read(join(dest, "config.yaml"))).toContain("Bearer ${MEMORIA_API_KEY}");
    expect(steps(plan)).toContain("Add MEMORIA_API_KEY to ~/.hermes/.env");
  });

  it("Cursor to OpenClaw: no key or reference is written, and the step keeps the key out of openclaw.json", async () => {
    const cur = buildCursorMemoria(join(src, "project"));
    const before = treeHash(cur);
    const oc = emptyDir(env.home, "u2o/.openclaw");
    const { plan, receipt } = await migrate({ adapter: "cursor", root: cur, nativeId: "main" }, { adapter: "openclaw", root: oc });
    const text = read(join(oc, "openclaw.json"));
    expect((JSON5.parse(text) as any).mcp.servers.memoria).toEqual({ url: MEMORIA_URL, transport: "streamable-http" });
    expect(text).not.toContain("${");
    expect(steps(plan)).toContain(`openclaw config set mcp.servers.memoria.headers.Authorization 'Bearer \${MEMORIA_API_KEY}'`);
    expectNoLeak(allText(oc), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
    expect(treeHash(cur)).toBe(before);
  });

  it("Claude Code to Cursor: Cursor's own reference syntax", async () => {
    const cc = buildClaudeCodeMemoria(src);
    const proj = emptyDir(env.home, "c2u");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "cursor", root: proj });
    const s = JSON.parse(read(join(proj, ".cursor/mcp.json"))).mcpServers.memoria;
    expect(s.url).toBe(MEMORIA_URL);
    expect(s.headers).toEqual({ Authorization: "Bearer ${env:MEMORIA_API_KEY}" });
    expectNoLeak(allText(proj));
  });

  it("a setup with no key says Memoria will refuse it", async () => {
    const h = buildHermesMemoria(src);
    const dest = emptyDir(env.home, "h2x/.codex");
    const { plan } = await migrate({ adapter: "hermes", root: h, nativeId: "default" }, { adapter: "codex", root: dest });
    expect((parseToml(read(join(dest, "config.toml"))) as any).mcp_servers.memoria).toEqual({ url: MEMORIA_URL });
    expect(steps(plan)).toContain(`"memoria" has no Memoria API key here, and Memoria refuses every request without one.`);
    expect(steps(plan)).not.toContain("MEMORIA_API_KEY");
  });

  it("a variable that already holds the key alone keeps its name", async () => {
    const cc = join(src, ".claude");
    mkdirSync(cc, { recursive: true });
    writeFileSync(join(cc, "CLAUDE.md"), "# Rules\n");
    writeFileSync(join(src, ".claude.json"), JSON.stringify({ mcpServers: { memoria: { type: "http", url: MEMORIA_URL, headers: { Authorization: "Bearer ${RESEARCHER_KEY}" } } } }));
    const dest = emptyDir(env.home, "own/.codex");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    expect((parseToml(read(join(dest, "config.toml"))) as any).mcp_servers.memoria).toEqual({ url: MEMORIA_URL, bearer_token_env_var: "RESEARCHER_KEY" });
    expect(steps(plan)).toContain("until RESEARCHER_KEY is set");
  });

  it("a .nomad package carries the key's variable, never the key", async () => {
    const r = await env.nomad.readLocation("claude-code", buildClaudeCodeMemoria(src), "main", { register: false });
    const pkg = packAgent(r.doc);
    expectNoLeak(new TextDecoder().decode(pkg.bytes), JSON.stringify(pkg.manifest));
    const fromCodex = await env.nomad.readLocation("codex", buildCodexMemoria(join(src, "cx")), "main", { register: false });
    const back = unpackAgent(packAgent(fromCodex.doc).bytes);
    expect(back.ok, JSON.stringify(back.issues)).toBe(true);
    expect((back.doc!.tools.find((t) => t.name === "memoria")!.mcp as Record<string, unknown>).bearerEnv).toBe("MEMORIA_API_KEY");
  });
});

describe("Memoria recognition", () => {
  const remote = (url: string, headers: Record<string, unknown> = {}): Tool =>
    ({ name: "x", kind: "mcp", mcp: { transport: "http", url, args: [], env: {}, headers } }) as unknown as Tool;

  it("recognises Memoria's server", () => {
    for (const u of [MEMORIA_URL, "https://www.memoriaagent.site/mcp/", "https://WWW.MEMORIAAGENT.site/mcp"]) expect(knownServerId(remote(u)), u).toBe("memoria");
    expect(applyKnownServerProfile(remote(MEMORIA_URL)).tool.mcp!.url).toBe(MEMORIA_URL);
  });

  it("ignores look-alikes", () => {
    for (const u of ["http://www.memoriaagent.site/mcp", "https://www.memoriaagent.site.evil.example/mcp", "https://evil.example/www.memoriaagent.site/mcp", "https://memoriaagent.site.evil.example/mcp", "https://www.memoriaagent.com/mcp", "https://www.memoriaagent.site:8443/mcp", "https://user@www.memoriaagent.site/mcp", "https://www.memoriaagent.site/docs.html", "https://www.memoriaagent.site/mcp/evil", "http://127.0.0.1:8765/mcp"]) {
      expect(knownServerId(remote(u)), u).toBeNull();
      expect(applyKnownServerProfile(remote(u)).notes, u).toEqual([]);
    }
  });

  it("a look-alike keeps its header as it was: no MEMORIA_API_KEY is made up for it", () => {
    const out = applyKnownServerProfile(remote("https://www.memoriaagent.site.evil.example/mcp", { Authorization: { secretRef: "Authorization", redacted: true } }));
    expect(out.tool.mcp!.headers).toEqual({ Authorization: { secretRef: "Authorization", redacted: true } });
    expect((out.tool.mcp as Record<string, unknown>).bearerEnv).toBeUndefined();
  });

  it("a key kept on purpose (--include-secrets) is left alone", () => {
    const out = applyKnownServerProfile(remote(MEMORIA_URL, { Authorization: { value: `Bearer ${FAKE_MEMORIA_KEY}` } }), "Codex");
    expect(out.tool.mcp!.headers).toEqual({ Authorization: { value: `Bearer ${FAKE_MEMORIA_KEY}` } });
    expect(out.manualSteps.join("\n")).not.toContain("keys are never copied");
    expect(out.manualSteps.join("\n")).not.toContain("has no Memoria API key");
  });

  it("finds Memoria keys in text, and only the real shape", () => {
    expect(scanText(`key: ${FAKE_MEMORIA_KEY}`, "t").some((f) => f.ruleId === "memoria-key")).toBe(true);
    expect(scanText("mem_3f9a1c2b7d4e_short", "t").some((f) => f.ruleId === "memoria-key")).toBe(false);
    expect(scanText("mem-1a2b3c4d", "t").some((f) => f.ruleId === "memoria-key")).toBe(false);
    expect(scanText(`${FAKE_MEMORIA_KEY}x`, "t").some((f) => f.ruleId === "memoria-key")).toBe(false);
  });

  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/memoria-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /supports memoria/i, /memoria integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(text.includes(FAKE_MEMORIA_KEY)).toBe(false);
  });
});
