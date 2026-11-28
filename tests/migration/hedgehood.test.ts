import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import { isKeyMaterialPath } from "@nomad/core/node";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_HH_SECRETS, HH_ACCOUNT, buildClaudeCodeHedgehood, buildCodexHedgehood, buildCursorHedgehood, buildGeminiHedgehood, buildHermesHedgehood } from "../fixtures/hedgehood";

/**
 * Hedgehood setups (an options market for AI agents on Robinhood Chain) moving between
 * platforms, mostly on mainnet. Fixtures follow what Hedgehood writes and documents; keys are fake.
 */

let env: Env;
let hh: string;
beforeEach(() => {
  env = setup();
  hh = join(env.home, "hh");
  mkdirSync(hh, { recursive: true });
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
  for (const t of texts) for (const s of FAKE_HH_SECRETS) expect(t.includes(s), `leaked a ${s.length} character secret`).toBe(false);
}

const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");
const items = (plan: { unsupported: Array<{ item: string; reason: string }> }) => plan.unsupported.map((u) => `${u.item}: ${u.reason}`).join("\n");
const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");

describe("Hedgehood setups", () => {
  it("Claude Code to Codex: mainnet entry, hosted server, plugin server and skill arrive; keys stay", async () => {
    const src = buildClaudeCodeHedgehood(hh);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    const main = cfg.mcp_servers.hedgehood;
    expect(main.command).toBe("npx");
    expect(main.args).toEqual(["-y", "@hedgehood-io/mcp"]);
    expect(main.env.HEDGEHOOD_CHAIN_ID).toBe("4663");
    expect(main.env.HEDGEHOOD_ACCOUNT).toBe(HH_ACCOUNT);
    // The key file setting is forwarded from the shell, never written as a value.
    expect(main.env.HEDGEHOOD_SESSION_KEY_FILE).toBeUndefined();
    expect(main.env_vars).toContain("HEDGEHOOD_SESSION_KEY_FILE");
    expect(cfg.mcp_servers["hedgehood-read"]).toEqual({ url: "https://mcp.hedgehood.io/mcp" });
    // The plugin's server keeps the plugin's own testnet setting.
    const fromPlugin = Object.entries(cfg.mcp_servers).find(([n]) => n !== "hedgehood" && n.startsWith("hedgehood") && n !== "hedgehood-read")?.[1] as any;
    expect(fromPlugin.args).toEqual(["-y", "@hedgehood-io/mcp"]);
    expect(fromPlugin.env.HEDGEHOOD_CHAIN_ID).toBe("46630");
    // The plugin lists its skill by its own folder; the skill and its reference file arrive.
    expect(existsSync(join(dest, "skills/hedgehood-options/SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "skills/hedgehood-options/references/markets.md"))).toBe(true);
    expect(warnings(plan)).toContain('"hedgehood" runs on Robinhood Chain mainnet (4663): trades settle in real USDG.');
    expect(notes(plan)).toContain("runs on the Robinhood Chain testnet (46630), with test funds.");
    expect(notes(plan)).toContain("Nomad never reads that folder or any key file");
    expect(warnings(plan)).toContain("the session key does not come along");
    expect(warnings(plan)).toContain("hedgehood session revoke <old session address> --send");
    expect(notes(plan)).toContain('"hedgehood-read" is a read-only server run by Hedgehood');
    expect(items(plan)).toContain("hedgehood: HEDGEHOOD_SESSION_KEY_FILE: Hedgehood keys and key files are references only");
    expect(steps(plan)).toContain("runs Hedgehood through npx: Codex needs Node.js 20 or later");
    if (existsSync(join(src, "skills/notes/NOTES.md"))) expect(plan.notes.some((n) => /can hold wallet keys/.test(n.message))).toBe(true);
    expect(existsSync(join(dest, "skills/notes/NOTES.md"))).toBe(false);
    expectNoLeak(JSON.stringify(plan), JSON.stringify(receipt), allText(dest));
  });

  it("Codex to Claude Code: literal limits carried, the raw owner key never written, owner key flagged", async () => {
    const src = buildCodexHedgehood(hh);
    const dest = emptyDir(env.home, "x2c/.claude");
    const { plan, receipt } = await migrate({ adapter: "codex", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest });
    const s = JSON.parse(read(join(env.home, "x2c/.claude.json"))).mcpServers;
    const e = s.hedgehood.env;
    expect(s.hedgehood.args).toEqual(["-y", "@hedgehood-io/mcp@0.5.1"]);
    expect(e.HEDGEHOOD_CHAIN_ID).toBe("4663");
    expect(e.HEDGEHOOD_ACCOUNT).toBe(HH_ACCOUNT);
    expect(e.HEDGEHOOD_MAX_DEPOSIT).toBe("50");
    expect(e.HEDGEHOOD_DRY_RUN).toBe("false");
    expect(e.HEDGEHOOD_OWNER_KEY).toBe("${HEDGEHOOD_OWNER_KEY}");
    expect(e.HEDGEHOOD_SESSION_KEY_FILE).toBe("${HEDGEHOOD_SESSION_KEY_FILE}");
    expect(s["hedgehood-read"].url).toBe("https://mcp.hedgehood.io/mcp");
    expect(s["hedgehood-old"]).toBeUndefined();
    expect(items(plan)).toContain("hedgehood-old: Disabled on the source");
    expect(warnings(plan)).toContain('"hedgehood" was given the owner key. The owner key can withdraw funds and manage sessions');
    expectNoLeak(JSON.stringify(plan), JSON.stringify(receipt), allText(join(env.home, "x2c")));
  });

  it("the raw owner key is never written as a value, even with --include-secrets", async () => {
    const src = buildCodexHedgehood(hh);
    const dest = emptyDir(env.home, "x2c-secrets/.claude");
    const { plan, receipt } = await migrate({ adapter: "codex", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest }, { includeSecrets: true });
    const e = JSON.parse(read(join(env.home, "x2c-secrets/.claude.json"))).mcpServers.hedgehood.env;
    expect(e.HEDGEHOOD_OWNER_KEY).toBe("${HEDGEHOOD_OWNER_KEY}");
    // With --include-secrets the key file path (not a secret) is kept as written.
    expect(e.HEDGEHOOD_SESSION_KEY_FILE).toBe("/home/agent/.hedgehood/session.key");
    expectNoLeak(JSON.stringify(plan), JSON.stringify(receipt), allText(join(env.home, "x2c-secrets")));
  });

  it("Hermes to Claude Code: a network that is a reference is explained, a deposit cap that is a reference is not carried", async () => {
    const src = buildHermesHedgehood(hh);
    const dest = emptyDir(env.home, "h2c/.claude");
    const { plan } = await migrate({ adapter: "hermes", root: src, nativeId: "default" }, { adapter: "claude-code", root: dest });
    const e = JSON.parse(read(join(env.home, "h2c/.claude.json"))).mcpServers.hedgehood.env ?? {};
    expect(e.HEDGEHOOD_DRY_RUN).toBe("true");
    expect(e.HEDGEHOOD_MAX_DEPOSIT).toBeUndefined();
    expect(items(plan)).toContain("hedgehood: HEDGEHOOD_MAX_DEPOSIT: Limit not carried: it was a reference on the source, so the destination uses Hedgehood defaults (1000 USDG per deposit).");
    expect(warnings(plan)).toContain('"hedgehood" does not fix the network in its entry, so Hedgehood takes it from ~/.hedgehood/config.json on that computer, or uses the testnet (46630) if there is none. Set HEDGEHOOD_CHAIN_ID=4663 on Claude Code for mainnet.');
  });

  it("Gemini CLI to Cursor: the global command with --mainnet is kept and named mainnet", async () => {
    const src = buildGeminiHedgehood(hh);
    const dest = emptyDir(env.home, "g2cur");
    const { plan } = await migrate({ adapter: "gemini-cli", root: src, nativeId: "main" }, { adapter: "cursor", root: dest });
    expect(JSON.parse(read(join(dest, ".cursor/mcp.json"))).mcpServers.hedgehood).toEqual({ command: "hedgehood-mcp", args: ["--mainnet"] });
    expect(warnings(plan)).toContain('"hedgehood" runs on Robinhood Chain mainnet (4663)');
    expect(steps(plan)).toContain("npm install -g @hedgehood-io/mcp");
  });

  it("Cursor to Gemini CLI and Hermes: the generic entry arrives in each format", async () => {
    const src = buildCursorHedgehood(hh);
    const gem = emptyDir(env.home, "cur2g/.gemini");
    await migrate({ adapter: "cursor", root: src, nativeId: "main" }, { adapter: "gemini-cli", root: gem });
    const g = JSON.parse(read(join(gem, "settings.json"))).mcpServers.hedgehood;
    expect(g.args).toEqual(["-y", "@hedgehood-io/mcp"]);
    expect(g.env.HEDGEHOOD_CHAIN_ID).toBe("4663");
    const her = emptyDir(env.home, "cur2h/.hermes");
    await migrate({ adapter: "cursor", root: src, nativeId: "main" }, { adapter: "hermes", root: her });
    const h = (parseYaml(read(join(her, "config.yaml"))) as any).mcp_servers.hedgehood;
    expect(h.env.HEDGEHOOD_CHAIN_ID).toBe("4663");
    expect(h.env.HEDGEHOOD_ACCOUNT).toBe(HH_ACCOUNT);
  });

  it("Claude Code to Claude Code: the plugin is reinstalled from Hedgehood's marketplace, with or without the record", async () => {
    for (const knownMarketplaces of [true, false]) {
      const home = join(env.home, `cc-${knownMarketplaces}`);
      mkdirSync(home, { recursive: true });
      const src = buildClaudeCodeHedgehood(home, { knownMarketplaces });
      const dest = emptyDir(env.home, `cc2cc-${knownMarketplaces}/.claude`);
      const { plan } = await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest });
      expect(steps(plan)).toContain("/plugin marketplace add 0xHedgeHood/hedgehood-agent-kit, then /plugin install hedgehood-options@hedgehood");
    }
  });

  it("never leaks a key anywhere, even with include-secrets, and leaves sources and ~/.hedgehood untouched", async () => {
    const builders: Array<[string, (h: string) => string, string]> = [
      ["claude-code", buildClaudeCodeHedgehood, "main"],
      ["codex", buildCodexHedgehood, "main"],
      ["hermes", buildHermesHedgehood, "default"],
      ["cursor", buildCursorHedgehood, "main"],
      ["gemini-cli", buildGeminiHedgehood, "main"]
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
          expectNoLeak(JSON.stringify(plan), JSON.stringify(receipt), allText(join(d, "..")));
          const again = await env.nomad.plan({ source: { kind: "location", adapter: id, root, nativeId }, destination: { adapter: to, root: d }, includeSecrets });
          expect(again.summary.create + again.summary.update, `${id} -> ${to} is idempotent`).toBe(0);
        }
      }
      const exp = await env.nomad.exportAgent({ kind: "location", adapter: id, root, nativeId }, { outPath: join(env.home, `exp-${id}.nomad`) });
      expectNoLeak(Buffer.from(exp.bytes).toString("latin1"), ...[...exp.files.values()].map((b) => Buffer.from(b).toString("utf8")));
      expect(treeHash(home), `${id} source and ~/.hedgehood unchanged`).toBe(hash);
    }
    expectNoLeak(allText(join(env.nomadHome, "backups")));
  });
});

describe("Hedgehood profile", () => {
  it("warns when a local setup names no account, which its server needs to start", () => {
    const tool = (env: Record<string, unknown>) => ({ name: "hh", kind: "mcp", mcp: { transport: "stdio", command: "npx", args: ["-y", "@hedgehood-io/mcp"], env, headers: {} } }) as never;
    const none = applyKnownServerProfile(tool({}), "Codex");
    expect(none.notes.some((n) => n.level === "warning" && n.message.includes("names no account, and Hedgehood's local server does not start without one"))).toBe(true);
    const withAccount = applyKnownServerProfile(tool({ HEDGEHOOD_ACCOUNT: { value: HH_ACCOUNT } }), "Codex");
    expect(withAccount.notes.some((n) => n.message.includes("names no account"))).toBe(false);
  });
  const tool = (command: string, args: string[], extra: Record<string, unknown> = {}) => ({ name: "x", kind: "mcp", mcp: { transport: "stdio", command, args, env: {}, headers: {}, ...extra } }) as any;
  const remote = (url: string) => ({ name: "x", kind: "mcp", mcp: { transport: "http", url, args: [], env: {}, headers: {} } }) as any;

  it("recognises every documented way of running Hedgehood, and nothing else", () => {
    for (const t of [
      tool("npx", ["-y", "@hedgehood-io/mcp"]),
      tool("npx", ["-y", "@hedgehood-io/mcp@0.5.1"]),
      tool("hedgehood-mcp", []),
      tool("/usr/local/bin/hedgehood-mcp", ["--mainnet"]),
      tool("C:\\Users\\ada\\AppData\\Roaming\\npm\\hedgehood-mcp.cmd", []),
      remote("https://mcp.hedgehood.io/mcp"),
      remote("https://testnet-mcp.hedgehood.io/mcp")
    ]) expect(knownServerId(t), JSON.stringify(t.mcp)).toBe("hedgehood");
    for (const t of [tool("hedgehood", ["status"]), tool("npx", ["-y", "@hedgehood-io/cli"]), tool("npx", ["-y", "@hedgehood-io/sdk"]), remote("https://hedgehood.app/mcp"), remote("https://mcp.hedgehood.io.evil.example/mcp")]) {
      expect(knownServerId(t), JSON.stringify(t.mcp)).not.toBe("hedgehood");
    }
  });

  it("turns raw keys into references and leaves the source tool unchanged", () => {
    const t = tool("npx", ["-y", "@hedgehood-io/mcp"], { env: { HEDGEHOOD_SESSION_KEY: { value: "0x" + "1".repeat(64) }, HEDGEHOOD_CHAIN_ID: { value: "4663" } } });
    const before = JSON.stringify(t);
    const out = applyKnownServerProfile(t, "Codex");
    expect(JSON.stringify(t)).toBe(before);
    expect(out.tool.mcp!.env.HEDGEHOOD_SESSION_KEY).toEqual({ secretRef: "HEDGEHOOD_SESSION_KEY", redacted: true });
    expect(out.tool.mcp!.env.HEDGEHOOD_CHAIN_ID).toEqual({ value: "4663" });
    expect(Object.keys(out.tool.mcp!.env).sort()).toEqual(["HEDGEHOOD_CHAIN_ID", "HEDGEHOOD_SESSION_KEY"]);
  });

  it("leaves Oak and Priors recognised as before", () => {
    expect(knownServerId(tool("oak", ["mcp"]))).toBe("oak");
    expect(knownServerId(tool("npx", ["-y", "@priors/mcp@0.20.0"]))).toBe("priors");
  });
});

describe("Hedgehood key folder", () => {
  it("is key material, and similar names are not", () => {
    const home = mkdtempSync(join(tmpdir(), "nomad-hh-"));
    try {
      mkdirSync(join(home, ".hedgehood"), { recursive: true });
      writeFileSync(join(home, ".hedgehood", "session.key"), "x");
      for (const p of [".hedgehood/session.key", ".hedgehood/owner.key", ".hedgehood/payer.key", ".hedgehood/config.json", ".hedgehood"]) expect(isKeyMaterialPath(join(home, p)), p).toBe(true);
      for (const p of ["hedgehood/notes.md", ".hedgehoods/x", "projects/.hedgehood-docs/readme.md"]) expect(isKeyMaterialPath(join(home, p)), p).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Hedgehood wording", () => {
  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/hedgehood-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner\b/i, /airdrop/i, /token launch/i, /supports hedgehood/i, /hedgehood integration/i]) expect(re.test(text), String(re)).toBe(false);
    expect(/(?<!Robin)Hood Chain/.test(text)).toBe(false);
  });
});
