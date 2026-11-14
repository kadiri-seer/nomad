import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import { isKeyMaterialPath } from "@nomad/core/node";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_OAK_RELAY_KEY, FAKE_OAK_SECRETS, buildClaudeCodeOak, buildCodexOak, buildCursorOak, buildGeminiOak, buildHermesOak } from "../fixtures/oak";

/**
 * Oak Agent Kit setups (a local wallet and tools for Robinhood Chain projects)
 * moving between platforms. Fixtures follow what Oak writes and documents; secrets are fake.
 */

let env: Env;
let oh: string; // a separate fake home for the Oak fixtures
beforeEach(() => {
  env = setup();
  oh = join(env.home, "oh");
  mkdirSync(oh, { recursive: true });
});
afterEach(() => env.cleanup());

type Loc = { adapter: string; root: string; nativeId: string };

async function migrate(source: Loc, dest: { adapter: string; root: string; nativeId?: string }, opts: { mode?: "merge" | "copy" | "replace"; includeSecrets?: boolean } = {}) {
  const plan = await env.nomad.plan({ source: { kind: "location", ...source }, destination: dest, mode: opts.mode, includeSecrets: opts.includeSecrets });
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
  for (const t of texts) for (const s of FAKE_OAK_SECRETS) expect(t.includes(s), `leaked a ${s.length} character secret`).toBe(false);
}

const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");
const items = (plan: { unsupported: Array<{ item: string; reason: string }> }) => plan.unsupported.map((u) => `${u.item}: ${u.reason}`).join("\n");
const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const servers = (obj: Record<string, any>) => Object.values(obj) as any[];

describe("Oak setups", () => {
  it("Claude Code to Codex: the oak entry and the plugin's npx entry arrive, the wallet stays", async () => {
    const src = buildClaudeCodeOak(oh);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    const all = servers(cfg.mcp_servers);
    expect(cfg.mcp_servers.oak).toEqual({ command: "oak", args: ["mcp"] });
    // The plugin's server is written as an ordinary entry with Oak's pinned version kept.
    expect(all.some((s) => s.command === "npx" && JSON.stringify(s.args) === JSON.stringify(["-y", "@oakagentkit/addon@0.3.7", "mcp"]))).toBe(true);
    expect(notes(plan)).toContain("Nomad never reads ~/.oak");
    expect(notes(plan)).toContain("Oak creates a new, empty wallet there the first time it starts");
    expect(notes(plan)).toContain("MCP form elicitation");
    expect(steps(plan)).toContain("npm install -g @oakagentkit/addon");
    expect(steps(plan)).toContain("runs Oak through npx: Codex needs Node.js 22.12 or later");
    // The symlink into ~/.oak was not followed. (Windows runners may not allow creating it.)
    if (existsSync(join(src, "skills/notes/NOTES.md"))) expect(plan.notes.some((n) => /can hold wallet keys/.test(n.message))).toBe(true);
    expect(existsSync(join(dest, "skills/notes/NOTES.md"))).toBe(false);
    expectNoLeak(JSON.stringify(plan), JSON.stringify(receipt), allText(dest));
  });

  it("Codex to Claude Code: literal settings carried, API key only as a reference, disabled server left out", async () => {
    const src = buildCodexOak(oh);
    const dest = emptyDir(env.home, "x2c/.claude");
    const { plan, receipt } = await migrate({ adapter: "codex", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest });
    const s = JSON.parse(read(join(env.home, "x2c/.claude.json"))).mcpServers;
    expect(s.oak.command).toBe("oak");
    expect(s.oak.args).toEqual(["mcp"]);
    const pinned = s["oak-pinned"];
    expect(pinned.args).toEqual(["-y", "@oakagentkit/addon@0.3.8", "mcp"]);
    expect(pinned.env.OAK_CHAIN_ID).toBe("4663");
    expect(pinned.env.OAK_AUTO_DAILY_CAP_USD).toBe("25");
    expect(pinned.env.OAK_RELAY_API_KEY).toBe("${OAK_RELAY_API_KEY}");
    expect(s["oak-old"]).toBeUndefined();
    expect(items(plan)).toContain("oak-old: Disabled on the source");
    expectNoLeak(JSON.stringify(plan), JSON.stringify(receipt), allText(join(env.home, "x2c")));
  });

  it("Gemini CLI to Hermes: a daily budget that was a reference is not carried, and the plan says Oak's default", async () => {
    const src = buildGeminiOak(oh);
    const dest = emptyDir(env.home, "g2h/.hermes");
    const { plan } = await migrate({ adapter: "gemini-cli", root: src, nativeId: "main" }, { adapter: "hermes", root: dest });
    const cfg = parseYaml(read(join(dest, "config.yaml"))) as any;
    expect(cfg.mcp_servers.oak.command).toBe("oak");
    expect(cfg.mcp_servers.oak.args).toEqual(["mcp"]);
    expect(cfg.mcp_servers.oak.env?.OAK_AUTO_DAILY_CAP_USD).toBeUndefined();
    expect(items(plan)).toContain("oak: OAK_AUTO_DAILY_CAP_USD: Limit not carried: it was a reference on the source, so the destination uses Oak defaults (50 USD a day for automatic approvals).");
  });

  it("Hermes to Claude Code: a network that is a reference is flagged, a literal budget is kept", async () => {
    const src = buildHermesOak(oh);
    const dest = emptyDir(env.home, "h2c/.claude");
    const { plan } = await migrate({ adapter: "hermes", root: src, nativeId: "default" }, { adapter: "claude-code", root: dest });
    const s = JSON.parse(read(join(env.home, "h2c/.claude.json"))).mcpServers;
    expect(s.oak.env.OAK_AUTO_DAILY_CAP_USD).toBe("10");
    // Hermes drops unset references, so Nomad lists this one as a step instead of writing it.
    expect(s.oak.env.OAK_NETWORK).toBeUndefined();
    expect(steps(plan)).toContain("OAK_NETWORK");
    expect(notes(plan)).toContain('"oak": OAK_NETWORK is a reference. Set it on Claude Code too; without it Oak uses Robinhood Chain mainnet.');
  });

  it("Claude Code to Cursor and Gemini CLI: the entry Oak's own connect command writes", async () => {
    const src = buildClaudeCodeOak(oh);
    const cur = emptyDir(env.home, "c2cur");
    await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "cursor", root: cur });
    expect(JSON.parse(read(join(cur, ".cursor/mcp.json"))).mcpServers.oak).toEqual({ command: "oak", args: ["mcp"] });
    const gem = emptyDir(env.home, "c2g/.gemini");
    await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "gemini-cli", root: gem });
    expect(JSON.parse(read(join(gem, "settings.json"))).mcpServers.oak).toEqual({ command: "oak", args: ["mcp"] });
  });

  it("Claude Code to Claude Code: the plugin is reinstalled from Oak's marketplace, with or without the marketplace record", async () => {
    for (const knownMarketplaces of [true, false]) {
      const home = join(env.home, `cc-${knownMarketplaces}`);
      mkdirSync(home, { recursive: true });
      const src = buildClaudeCodeOak(home, { knownMarketplaces });
      const dest = emptyDir(env.home, `cc2cc-${knownMarketplaces}/.claude`);
      const { plan } = await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest });
      expect(steps(plan)).toContain("/plugin marketplace add OakAgentKit/oak, then /plugin install oak@oak-agent-kit");
    }
  });

  it("never leaks the wallet anywhere, even with include-secrets, and leaves sources and ~/.oak untouched", async () => {
    const builders: Array<[string, (h: string) => string, string]> = [
      ["claude-code", buildClaudeCodeOak, "main"],
      ["codex", buildCodexOak, "main"],
      ["hermes", buildHermesOak, "default"],
      ["cursor", buildCursorOak, "main"],
      ["gemini-cli", buildGeminiOak, "main"]
    ];
    const dests: Array<[string, (n: string) => string]> = [
      ["claude-code", (n) => emptyDir(env.home, `${n}/.claude`)],
      ["codex", (n) => emptyDir(env.home, `${n}/.codex`)],
      ["hermes", (n) => emptyDir(env.home, `${n}/.hermes`)]
    ];
    for (const [id, build, nativeId] of builders) {
      const home = join(env.home, `src-${id}`);
      mkdirSync(home, { recursive: true });
      const root = build(home);
      const hash = treeHash(home);
      for (const [to, mk] of dests) {
        if (to === id) continue;
        for (const includeSecrets of [false, true]) {
          const d = mk(`leak-${id}-${to}-${includeSecrets}`);
          const { plan, receipt } = await migrate({ adapter: id, root, nativeId }, { adapter: to, root: d }, { includeSecrets });
          const out = [JSON.stringify(plan), JSON.stringify(receipt), allText(join(d, ".."))];
          expectNoLeak(...out);
          // An API key typed into a config is carried only when the user asks for secrets.
          if (!includeSecrets) for (const t of out) expect(t.includes(FAKE_OAK_RELAY_KEY), `${id} -> ${to} carried the API key without --include-secrets`).toBe(false);
          const again = await env.nomad.plan({ source: { kind: "location", adapter: id, root, nativeId }, destination: { adapter: to, root: d }, includeSecrets });
          expect(again.summary.create + again.summary.update, `${id} -> ${to} is idempotent`).toBe(0);
        }
      }
      const exp = await env.nomad.exportAgent({ kind: "location", adapter: id, root, nativeId }, { outPath: join(env.home, `exp-${id}.nomad`) });
      const exported = [Buffer.from(exp.bytes).toString("latin1"), ...[...exp.files.values()].map((b) => Buffer.from(b).toString("utf8"))];
      expectNoLeak(...exported);
      for (const t of exported) expect(t.includes(FAKE_OAK_RELAY_KEY), `${id} export carried the API key`).toBe(false);
      expect(treeHash(home), `${id} source and ~/.oak unchanged`).toBe(hash);
    }
    expectNoLeak(allText(join(env.nomadHome, "backups")));
  });

  it("the API key in the Codex config never leaves as a value without --include-secrets", async () => {
    const src = buildCodexOak(oh);
    const dest = emptyDir(env.home, "x2h/.hermes");
    const { plan, receipt } = await migrate({ adapter: "codex", root: src, nativeId: "main" }, { adapter: "hermes", root: dest });
    for (const t of [JSON.stringify(plan), JSON.stringify(receipt), allText(dest)]) expect(t.includes(FAKE_OAK_RELAY_KEY)).toBe(false);
  });
});

describe("Oak profile", () => {
  const tool = (command: string, args: string[], extra: Record<string, unknown> = {}) => ({ name: "x", kind: "mcp", mcp: { transport: "stdio", command, args, env: {}, headers: {}, ...extra } }) as any;

  it("recognises every documented way of starting Oak, and nothing else", () => {
    for (const t of [
      tool("oak", ["mcp"]),
      tool("/usr/local/bin/oak", ["mcp"]),
      tool("C:\\Users\\ada\\AppData\\Roaming\\npm\\oak.cmd", ["mcp"]),
      tool("npx", ["-y", "@oakagentkit/addon@0.3.3", "mcp"]),
      tool("npx", ["-y", "@oakagentkit/addon", "mcp"])
    ]) expect(knownServerId(t), JSON.stringify(t.mcp)).toBe("oak");
    for (const t of [tool("oak", ["status"]), tool("soak", ["mcp"]), tool("npx", ["-y", "@oakagentkit/core@0.3.8"]), tool("npx", ["-y", "oak-mcp"]), { name: "x", kind: "mcp", mcp: { transport: "http", url: "https://oakagentkit.org/mcp", env: {}, headers: {}, args: [] } } as any]) {
      expect(knownServerId(t), JSON.stringify(t.mcp)).not.toBe("oak");
    }
  });

  it("never adds variables and keeps the source tool unchanged", () => {
    const t = tool("oak", ["mcp"], { env: { OAK_AUTO_DAILY_CAP_USD: { value: "15" } } });
    const before = JSON.stringify(t);
    const out = applyKnownServerProfile(t, "Codex");
    expect(JSON.stringify(t)).toBe(before);
    expect(Object.keys(out.tool.mcp!.env)).toEqual(["OAK_AUTO_DAILY_CAP_USD"]);
    expect((out.tool.mcp as Record<string, unknown>).emptyOkEnv).toBeUndefined();
  });

  it("leaves Priors exactly as before", () => {
    const p = applyKnownServerProfile(tool("npx", ["-y", "@priors/mcp@0.20.0"], { env: { PRIORS_MAX_SPEND_DAY_USD: { secretRef: "PRIORS_MAX_SPEND_DAY_USD" } } }), "Codex");
    expect(knownServerId(p.tool)).toBe("priors");
    expect(p.unsupported.map((u) => u.reason).join("\n")).toContain("so the destination uses Priors defaults (defaults are looser: no daily caps).");
    expect((p.tool.mcp as Record<string, unknown>).emptyOkEnv).toEqual(["PRIORS_AGENT_ID"]);
  });
});

describe("Oak wallet folder", () => {
  it("is key material wherever it is found, and similar names are not", () => {
    const home = mkdtempSync(join(tmpdir(), "nomad-oak-"));
    try {
      mkdirSync(join(home, ".oak"), { recursive: true });
      writeFileSync(join(home, ".oak", "wallet.enc"), "x");
      expect(isKeyMaterialPath(join(home, ".oak", "wallet.enc"))).toBe(true);
      expect(isKeyMaterialPath(join(home, ".oak"))).toBe(true);
      expect(isKeyMaterialPath(join(home, ".oak", "0xabc.gloam.enc"))).toBe(true);
      expect(isKeyMaterialPath(join(home, ".oakley", "config.json"))).toBe(false);
      expect(isKeyMaterialPath(join(home, "projects", "oak", "README.md"))).toBe(false);
      expect(isKeyMaterialPath(join(home, "notes.oak"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Oak wording", () => {
  it("the Oak guide follows the same wording rules as the Priors docs", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/oak-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner\b/i, /airdrop/i, /token launch/i, /supports oak/i, /oak integration/i]) expect(re.test(text), String(re)).toBe(false);
    expect(/(?<!Robin)Hood Chain/.test(text)).toBe(false);
  });
});
