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
import { FAKE_ZOLVA_KEY, FAKE_ZOLVA_SECRETS, ZOLVA_URL, buildClaudeCodeZolva, buildCodexZolva, buildCursorZolva, buildHermesZolva } from "../fixtures/zolva";

/**
 * Zolva setups (a hosted server for trading agents on Robinhood Chain: read-only without a key, more tools
 * with an optional "Authorization: Bearer zk_..." key) moving between platforms. Keys are fake.
 */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "zolva");
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
  for (const t of texts) for (const s of FAKE_ZOLVA_SECRETS) expect(t.includes(s), "a Zolva key leaked").toBe(false);
}

const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");
const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");
const KEYLESS = `"zolva" is Zolva's hosted server for trading agents on Robinhood Chain. Without a key it has seven read-only tools and needs no wallet`;

describe("Zolva setups", () => {
  it("Claude Code to Codex: the key in the header becomes bearer_token_env_var = ZOLVA_KEY, and is never written", async () => {
    const cc = buildClaudeCodeZolva(src);
    const before = treeHash(cc);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(cfg.mcp_servers.zolva).toEqual({ url: ZOLVA_URL, bearer_token_env_var: "ZOLVA_KEY" });
    expect(notes(plan)).toContain(KEYLESS);
    expect(steps(plan)).toContain(`The "zolva" key is your Zolva API key (zk_..., from Settings, API keys on zolvaagent.app); keys are never copied. Until ZOLVA_KEY is set, the server does not work on Codex, keyless tools included.`);
    expect(steps(plan)).toContain("leave out its key setting (bearer_token_env_var)");
    expect(notes(plan)).toContain("Give the key only the scopes this agent needs. Zolva never moves funds through MCP.");
    expect(steps(plan)).toContain(`Set ZOLVA_KEY in your shell to the key alone before starting Codex: the "zolva" MCP server sends it as a bearer token (bearer_token_env_var).`);
    expect(steps(plan)).not.toContain("Add an Authorization header");
    expect(warnings(plan)).not.toContain("Zolva");
    // A key in the instructions is caught too.
    expect(read(join(dest, "AGENTS.md"))).toContain("[REDACTED:zolva-key]");
    expectNoLeak(allText(dest), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
    expect(treeHash(cc)).toBe(before);
  });

  it("Codex to Claude Code: bearer_token_env_var arrives as \"Bearer ${ZOLVA_KEY}\"", async () => {
    const cx = buildCodexZolva(src);
    const before = treeHash(cx);
    const dest = emptyDir(env.home, "x2c/.claude");
    const { plan } = await migrate({ adapter: "codex", root: cx, nativeId: "main" }, { adapter: "claude-code", root: dest });
    const s = JSON.parse(read(join(env.home, "x2c/.claude.json"))).mcpServers.zolva;
    expect(s).toEqual({ type: "http", url: ZOLVA_URL, headers: { Authorization: "Bearer ${ZOLVA_KEY}" } });
    expect(steps(plan)).toContain(`Set ZOLVA_KEY in your environment to the key alone, so the "zolva" MCP server can authenticate in Claude Code: Nomad writes its Authorization header as "Bearer \${ZOLVA_KEY}".`);
    expect(steps(plan)).toContain("leave out its key setting (the Authorization header)");
    expect(treeHash(cx)).toBe(before);
  });

  it("Codex to Claude Code and back: the setup is the same as Zolva's docs write it", async () => {
    const cx = buildCodexZolva(src);
    const cc = emptyDir(env.home, "rt/.claude");
    await migrate({ adapter: "codex", root: cx, nativeId: "main" }, { adapter: "claude-code", root: cc });
    const back = emptyDir(env.home, "rt2/.codex");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: back });
    expect((parseToml(read(join(back, "config.toml"))) as any).mcp_servers.zolva).toEqual({ url: ZOLVA_URL, bearer_token_env_var: "ZOLVA_KEY" });
  });

  it("Codex to Hermes: the header uses ${ZOLVA_KEY}, and the steps say where to put it", async () => {
    const cx = buildCodexZolva(src);
    const dest = emptyDir(env.home, "x2h/.hermes");
    const { plan } = await migrate({ adapter: "codex", root: cx, nativeId: "main" }, { adapter: "hermes", root: dest });
    const text = read(join(dest, "config.yaml"));
    expect(text).toContain("Bearer ${ZOLVA_KEY}");
    expect(steps(plan)).toContain("Add ZOLVA_KEY to ~/.hermes/.env");
    expect(steps(plan)).toContain(`ZOLVA_KEY holds the key alone: Nomad writes the "zolva" MCP server's Authorization header as "Bearer \${ZOLVA_KEY}".`);
  });

  it("Cursor to OpenClaw: no key or reference is written, and the step keeps the key out of openclaw.json", async () => {
    const cur = buildCursorZolva(join(src, "project"));
    const before = treeHash(cur);
    const oc = emptyDir(env.home, "u2o/.openclaw");
    const { plan, receipt } = await migrate({ adapter: "cursor", root: cur, nativeId: "main" }, { adapter: "openclaw", root: oc });
    const text = read(join(oc, "openclaw.json"));
    expect((JSON5.parse(text) as any).mcp.servers.zolva).toEqual({ url: ZOLVA_URL, transport: "streamable-http" });
    expect(text).not.toContain("${");
    expect(steps(plan)).toContain(`Set the Authorization header for the "zolva" MCP server in OpenClaw. To keep the key out of openclaw.json, set ZOLVA_KEY to the key alone in the environment OpenClaw starts with, then run: openclaw config set mcp.servers.zolva.headers.Authorization 'Bearer \${ZOLVA_KEY}'`);
    expect(steps(plan)).not.toContain("Add an Authorization header");
    expectNoLeak(allText(oc), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
    expect(treeHash(cur)).toBe(before);
  });

  it("Claude Code to Cursor: Cursor's own reference syntax", async () => {
    const cc = buildClaudeCodeZolva(src);
    const proj = emptyDir(env.home, "c2u");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "cursor", root: proj });
    const s = JSON.parse(read(join(proj, ".cursor/mcp.json"))).mcpServers.zolva;
    expect(s.url).toBe(ZOLVA_URL);
    expect(s.headers).toEqual({ Authorization: "Bearer ${env:ZOLVA_KEY}" });
    expectNoLeak(allText(proj));
  });

  it("Hermes to Codex: a keyless setup stays keyless", async () => {
    const h = buildHermesZolva(src);
    const dest = emptyDir(env.home, "h2x/.codex");
    const { plan } = await migrate({ adapter: "hermes", root: h, nativeId: "default" }, { adapter: "codex", root: dest });
    expect((parseToml(read(join(dest, "config.toml"))) as any).mcp_servers.zolva).toEqual({ url: ZOLVA_URL });
    expect(notes(plan)).toContain(KEYLESS);
    expect(steps(plan)).not.toContain("Zolva API key");
    expect(steps(plan)).not.toContain("ZOLVA_KEY");
    expect(notes(plan)).not.toContain("scopes");
  });

  it("a .nomad package carries the key's variable, never the key", async () => {
    const cc = buildClaudeCodeZolva(src);
    const r = await env.nomad.readLocation("claude-code", cc, "main", { register: false });
    const pkg = packAgent(r.doc);
    const text = new TextDecoder().decode(pkg.bytes);
    expectNoLeak(text, JSON.stringify(pkg.manifest));
    // Read from Claude Code the key was a value; Nomad removed it, so the package holds a reference.
    const back = unpackAgent(pkg.bytes);
    expect(back.ok, JSON.stringify(back.issues)).toBe(true);
    const zolva = back.doc!.tools.find((t) => t.name === "zolva")!;
    const fromCodex = await env.nomad.readLocation("codex", buildCodexZolva(join(src, "cx")), "main", { register: false });
    const pkg2 = unpackAgent(packAgent(fromCodex.doc).bytes);
    expect((pkg2.doc!.tools.find((t) => t.name === "zolva")!.mcp as Record<string, unknown>).bearerEnv).toBe("ZOLVA_KEY");
    expect(zolva.mcp!.url).toBe(ZOLVA_URL);
  });

  it("a variable that already holds the key alone keeps its name", async () => {
    const cc = join(src, ".claude");
    mkdirSync(cc, { recursive: true });
    writeFileSync(join(cc, "CLAUDE.md"), "# Rules\n");
    writeFileSync(join(src, ".claude.json"), JSON.stringify({ mcpServers: { zolva: { type: "http", url: ZOLVA_URL, headers: { Authorization: "Bearer ${MY_ZOLVA}" } } } }));
    const dest = emptyDir(env.home, "own/.codex");
    const { plan } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    expect((parseToml(read(join(dest, "config.toml"))) as any).mcp_servers.zolva).toEqual({ url: ZOLVA_URL, bearer_token_env_var: "MY_ZOLVA" });
    expect(steps(plan)).toContain("Until MY_ZOLVA is set, the server does not work on Codex");
    expect(steps(plan)).toContain("Set MY_ZOLVA in your shell to the key alone before starting Codex");
  });
});

describe("Bearer tokens in a variable, for any server", () => {
  it("Codex's bearer_token_env_var is read, and written back for Codex", async () => {
    const cx = join(src, ".codex");
    mkdirSync(cx, { recursive: true });
    writeFileSync(join(cx, "AGENTS.md"), "# Rules\n");
    writeFileSync(join(cx, "config.toml"), `[mcp_servers.docs]\nurl = "https://mcp.example.com/mcp"\nbearer_token_env_var = "DOCS_TOKEN"\n`);
    const cc = emptyDir(env.home, "b1/.claude");
    const { plan } = await migrate({ adapter: "codex", root: cx, nativeId: "main" }, { adapter: "claude-code", root: cc });
    expect(JSON.parse(read(join(env.home, "b1/.claude.json"))).mcpServers.docs.headers).toEqual({ Authorization: "Bearer ${DOCS_TOKEN}" });
    expect(steps(plan)).toContain("Set DOCS_TOKEN in your environment to the key alone");
    const back = emptyDir(env.home, "b2/.codex");
    await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: back });
    expect((parseToml(read(join(back, "config.toml"))) as any).mcp_servers.docs).toEqual({ url: "https://mcp.example.com/mcp", bearer_token_env_var: "DOCS_TOKEN" });
  });

  it("an Authorization header that already exists wins over bearer_token_env_var", async () => {
    const cx = join(src, ".codex");
    mkdirSync(cx, { recursive: true });
    writeFileSync(join(cx, "AGENTS.md"), "# Rules\n");
    writeFileSync(join(cx, "config.toml"), `[mcp_servers.docs]\nurl = "https://mcp.example.com/mcp"\nbearer_token_env_var = "DOCS_TOKEN"\n\n[mcp_servers.docs.env_http_headers]\nAuthorization = "DOCS_AUTH"\n`);
    const cc = emptyDir(env.home, "b3/.claude");
    await migrate({ adapter: "codex", root: cx, nativeId: "main" }, { adapter: "claude-code", root: cc });
    expect(JSON.parse(read(join(env.home, "b3/.claude.json"))).mcpServers.docs.headers).toEqual({ Authorization: "${DOCS_AUTH}" });
  });

  it("a local (stdio) server never gets a bearer header", async () => {
    const cx = join(src, ".codex");
    mkdirSync(cx, { recursive: true });
    writeFileSync(join(cx, "AGENTS.md"), "# Rules\n");
    writeFileSync(join(cx, "config.toml"), `[mcp_servers.local]\ncommand = "node"\nargs = ["server.js"]\nbearer_token_env_var = "LOCAL_TOKEN"\n`);
    const cc = emptyDir(env.home, "b4/.claude");
    await migrate({ adapter: "codex", root: cx, nativeId: "main" }, { adapter: "claude-code", root: cc });
    const s = JSON.parse(read(join(env.home, "b4/.claude.json"))).mcpServers.local;
    expect(s.headers).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain("LOCAL_TOKEN");
  });
});

describe("Zolva recognition", () => {
  const remote = (url: string, headers: Record<string, unknown> = {}): Tool =>
    ({ name: "x", kind: "mcp", mcp: { transport: "http", url, args: [], env: {}, headers } }) as unknown as Tool;

  it("recognises Zolva's server", () => {
    for (const u of [ZOLVA_URL, "https://zolvaagent.app/mcp/", "https://ZOLVAAGENT.app/mcp"]) expect(knownServerId(remote(u)), u).toBe("zolva");
    expect(applyKnownServerProfile(remote(ZOLVA_URL)).tool.mcp!.url).toBe(ZOLVA_URL);
  });

  it("ignores look-alikes", () => {
    for (const u of ["http://zolvaagent.app/mcp", "https://zolvaagent.app.evil.example/mcp", "https://evil.example/zolvaagent.app/mcp", "https://www.zolvaagent.app/mcp", "https://zolvaagent.com/mcp", "https://zolvaagent.app:8443/mcp", "https://user@zolvaagent.app/mcp", "https://zolvaagent.app/api/public/v1", "https://zolvaagent.app/mcp/evil"]) {
      expect(knownServerId(remote(u)), u).toBeNull();
      expect(applyKnownServerProfile(remote(u)).notes, u).toEqual([]);
    }
  });

  it("a look-alike keeps its header as it was: no ZOLVA_KEY is made up for it", () => {
    const out = applyKnownServerProfile(remote("https://zolvaagent.app.evil.example/mcp", { Authorization: { secretRef: "Authorization", redacted: true } }));
    expect(out.tool.mcp!.headers).toEqual({ Authorization: { secretRef: "Authorization", redacted: true } });
    expect((out.tool.mcp as Record<string, unknown>).bearerEnv).toBeUndefined();
  });

  it("a key kept on purpose (--include-secrets) is left alone", () => {
    const out = applyKnownServerProfile(remote(ZOLVA_URL, { Authorization: { value: `Bearer ${FAKE_ZOLVA_KEY}` } }), "Codex");
    expect(out.tool.mcp!.headers).toEqual({ Authorization: { value: `Bearer ${FAKE_ZOLVA_KEY}` } });
    expect(out.notes.map((n) => n.message).join("\n")).toContain("Give the key only the scopes this agent needs");
    expect(out.manualSteps.join("\n")).not.toContain("keys are never copied");
  });

  it("finds Zolva keys in text, and only the real shape", () => {
    expect(scanText(`key: ${FAKE_ZOLVA_KEY}`, "t").some((f) => f.ruleId === "zolva-key")).toBe(true);
    expect(scanText("zk_tooShort", "t").some((f) => f.ruleId === "zolva-key")).toBe(false);
    expect(scanText(`${FAKE_ZOLVA_KEY}x`, "t").some((f) => f.ruleId === "zolva-key")).toBe(false);
  });

  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/zolva-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /supports zolva/i, /zolva integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(/(?<!Robin)Hood Chain/.test(text)).toBe(false);
    expect(text.includes(FAKE_ZOLVA_KEY)).toBe(false);
  });
});
