import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { knownServerId } from "@nomad/adapters";
import { isKeyMaterialPath } from "@nomad/core/node";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_RUSHR_SECRETS, buildClaudeCodeRushr, buildCodexRushr, buildCursorRushr, buildGeminiRushr, buildHermesRushr } from "../fixtures/rushr";

/**
 * Rushr setups (a social trading terminal on Robinhood Chain that trades real ETH) moving between
 * platforms, including Rushr's Claude Code and Codex plugins. Fixtures follow what Rushr ships; keys are fake.
 */

let env: Env;
let rr: string;
beforeEach(() => {
  env = setup();
  rr = join(env.home, "rr");
  mkdirSync(rr, { recursive: true });
});
afterEach(() => env.cleanup());

type Loc = { adapter: string; root: string; nativeId: string };

async function migrate(source: Loc, dest: { adapter: string; root: string }, opts: { includeSecrets?: boolean } = {}) {
  const plan = await env.nomad.plan({ source: { kind: "location", ...source }, destination: dest, includeSecrets: opts.includeSecrets });
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
  for (const t of texts) for (const s of FAKE_RUSHR_SECRETS) expect(t.includes(s), `leaked a ${s.length} character secret`).toBe(false);
}

const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");
const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");
const items = (plan: { unsupported: Array<{ item: string; reason: string }> }) => plan.unsupported.map((u) => `${u.item}: ${u.reason}`).join("\n");

describe("Rushr setups", () => {
  it("Claude Code to Codex: the entry and the plugin's server and skill arrive; real money is named; keys stay", async () => {
    const src = buildClaudeCodeRushr(rr);
    const before = treeHash(src);
    const rushrBefore = treeHash(join(rr, ".rushr"));
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    const main = cfg.mcp_servers.rushr;
    expect(main.args).toEqual(["-y", "@rushr/mcp"]);
    expect(main.env).toEqual({ RUSHR_MAX_TRADE_USD: "5", RUSHR_DAILY_USD: "20" });
    // The key file setting is forwarded from the shell, never written as a value.
    expect(main.env_vars).toEqual(["RUSHR_WALLET_FILE"]);
    expect(cfg.mcp_servers["rushr-plugin"]).toEqual({ command: "npx", args: ["-y", "@rushr/mcp@latest"] });
    expect(existsSync(join(dest, "skills/rushr/SKILL.md"))).toBe(true);
    expect(warnings(plan)).toContain('"rushr" trades real ETH on Robinhood Chain mainnet (4663): up to $5 per buy and $20 per 24 hours.');
    expect(warnings(plan)).toContain('"rushr-plugin" trades real ETH on Robinhood Chain mainnet (4663): up to $10 per buy and $50 per 24 hours.');
    expect(notes(plan)).toContain('"rushr-plugin" names no wallet, so Rushr uses ~/.rushr/agent-wallet.json');
    expect(warnings(plan)).toContain("the wallet and its API key do not come along, and the daily spend count starts again there");
    expect(notes(plan)).toContain("Nomad never reads them, and never moves holdings, trades, callouts or the agent's registration.");
    expect(steps(plan)).toContain("rushr@rushr was an installed Claude Code plugin");
    expect(items(plan)).toContain("rushr: RUSHR_WALLET_FILE: Wallet keys and key files are references only.");
    expectNoLeak(allText(dest), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
    expect(treeHash(src)).toBe(before);
    expect(treeHash(join(rr, ".rushr"))).toBe(rushrBefore);
  });

  it("Codex to Codex: the plugin is reinstalled with Rushr's own commands, not copied; the raw key stays a reference", async () => {
    const src = buildCodexRushr(rr);
    const dest = emptyDir(env.home, "x2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "codex", root: src, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    expect(Object.keys(cfg.mcp_servers)).toEqual(["rushr-dry"]);
    expect(cfg.mcp_servers["rushr-dry"]).toEqual({ command: "npx", args: ["-y", "@rushr/mcp@0.1.2"], env_vars: ["RUSHR_PRIVATE_KEY"], env: { RUSHR_DRY_RUN: "1", RUSHR_MAX_TRADE_USD: "2", RUSHR_SLIPPAGE_BPS: "100" } });
    expect(existsSync(join(dest, "skills/rushr"))).toBe(false);
    expect(steps(plan)).toContain("Install the plugin rushr@rushr in Codex: codex plugin marketplace add rushr-dev/platform, then codex plugin add rushr@rushr. Nomad does not copy plugin servers or skills.");
    expect(steps(plan)).not.toContain("old@rushr");
    expect(notes(plan)).toContain('"rushr-dry" is in dry run (RUSHR_DRY_RUN=1): it quotes, builds and simulates trades but never signs or sends them');
    expect(notes(plan)).toContain("Read installed Codex plugin rushr@rushr");
    expectNoLeak(allText(dest), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
  });

  it("Codex to Claude Code: the Codex plugin's server and skill become ordinary entries", async () => {
    const src = buildCodexRushr(rr);
    const destHome = emptyDir(env.home, "x2c");
    const dest = emptyDir(destHome, ".claude");
    const { plan } = await migrate({ adapter: "codex", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest });
    const servers = JSON.parse(read(join(destHome, ".claude.json"))).mcpServers;
    expect(servers.rushr).toMatchObject({ command: "npx", args: ["-y", "@rushr/mcp@latest"] });
    expect(servers["rushr-dry"].env.RUSHR_DRY_RUN).toBe("1");
    expect(servers["old-server"]).toBeUndefined();
    expect(existsSync(join(dest, "skills/rushr/SKILL.md"))).toBe(true);
    expect(steps(plan)).toContain("rushr@rushr was an installed Codex plugin (installed plugin read, not installed). Its servers and skills are written to Claude Code as ordinary entries");
    expectNoLeak(allText(dest), read(join(destHome, ".claude.json")), JSON.stringify(plan));
  });

  it("a Codex plugin folder that leads outside Codex's plugin folder is not read", async () => {
    const outside = join(env.home, "elsewhere/plugin");
    const src = buildCodexRushr(rr, { pluginOutside: outside });
    if (!existsSync(join(src, "plugins/cache/rushr/rushr/0.1.2"))) return; // no symlinks on this system
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "codex", root: src, nativeId: "main" }, destination: { adapter: "claude-code", root: emptyDir(env.home, "x/.claude") } });
    expect(notes(plan)).toContain("Codex plugin rushr@rushr points outside Codex's plugin folder, so it was not read.");
    expect(steps(plan)).not.toContain("rushr@rushr was an installed Codex plugin");
  });

  it("Gemini CLI to Claude Code: both wallet settings were set, so neither is written", async () => {
    const src = buildGeminiRushr(rr);
    const destHome = emptyDir(env.home, "g2c");
    const dest = emptyDir(destHome, ".claude");
    const { plan, receipt } = await migrate({ adapter: "gemini-cli", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest });
    const server = JSON.parse(read(join(destHome, ".claude.json"))).mcpServers.rushr;
    expect(server.command).toBe("rushr-mcp");
    expect(server.env?.RUSHR_WALLET_FILE).toBeUndefined();
    expect(server.env?.RUSHR_PRIVATE_KEY).toBeUndefined();
    expect(steps(plan)).toContain('"rushr" listed both RUSHR_WALLET_FILE and RUSHR_PRIVATE_KEY, which Rushr refuses together, so Nomad wrote neither.');
    expect(steps(plan)).toContain("npm install -g @rushr/mcp. It needs Node.js 20 or later, and the rushr-mcp command must be on the PATH Claude Code uses.");
    expect(notes(plan)).not.toContain("names no wallet");
    expectNoLeak(read(join(destHome, ".claude.json")), JSON.stringify(plan), JSON.stringify(receipt));
  });

  it("Hermes to OpenClaw: dry run as a reference means real trades there, and the preview says so", async () => {
    const src = buildHermesRushr(rr);
    const dest = emptyDir(env.home, "h2o/.openclaw");
    const { plan } = await migrate({ adapter: "hermes", root: src, nativeId: "main" }, { adapter: "openclaw", root: dest });
    const text = read(join(dest, "openclaw.json"));
    const server = (JSON5.parse(text) as any).mcp.servers.rushr;
    expect(server.args).toEqual(["-y", "@rushr/mcp"]);
    expect(server.env).toEqual({ RUSHR_MAX_TRADE_USD: "3" });
    expect(text).not.toContain("${");
    expect(warnings(plan)).toContain('"rushr" took RUSHR_DRY_RUN from a variable on the source. Without it on OpenClaw, Rushr trades for real');
    expect(warnings(plan)).not.toContain('"rushr" trades real ETH on Robinhood Chain mainnet (4663): up to');
    expect(items(plan)).toContain("rushr: RUSHR_DRY_RUN: Limit not carried: it was a reference on the source, so the destination uses Rushr defaults (real trades, signed and sent).");
    expect(items(plan)).toContain("rushr: RUSHR_DAILY_USD: Limit not carried: it was a reference on the source, so the destination uses Rushr defaults ($50 per 24 hours).");
  });

  it("Cursor to Claude Code: a wallet file kept in the project is never read or copied", async () => {
    const src = buildCursorRushr(rr);
    const destHome = emptyDir(env.home, "cu2c");
    const dest = emptyDir(destHome, ".claude");
    const { plan, receipt } = await migrate({ adapter: "cursor", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest });
    expectNoLeak(allText(dest), read(join(destHome, ".claude.json")), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
  });

  it("with --include-secrets the wallet key still stays out, and exports never hold it", async () => {
    const src = buildCodexRushr(rr);
    const destHome = emptyDir(env.home, "s2c");
    const dest = emptyDir(destHome, ".claude");
    const { plan, receipt } = await migrate({ adapter: "codex", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest }, { includeSecrets: true });
    expect(warnings(plan)).toContain("wallet key(s) or recovery phrase(s) were left out although secrets are included");
    expectNoLeak(allText(dest), read(join(destHome, ".claude.json")), JSON.stringify(plan), JSON.stringify(receipt));
    const exp = await env.nomad.exportAgent({ kind: "location", adapter: "codex", root: src, nativeId: "main" }, { outPath: join(env.home, "r.nomad"), includeSecrets: true });
    expectNoLeak(readFileSync(exp.path!).toString("latin1"));
  });
});

describe("Rushr recognition and protected files", () => {
  const local = (command: string, args: string[] = []): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "stdio", command, args, env: {}, headers: {} } }) as unknown as Tool;

  it("recognises Rushr's real package and command", () => {
    for (const t of [local("npx", ["-y", "@rushr/mcp"]), local("npx", ["-y", "@rushr/mcp@latest"]), local("npx", ["-y", "@rushr/mcp@0.1.2"]), local("rushr-mcp"), local("/usr/local/bin/rushr-mcp"), local("C:\\Users\\a\\AppData\\Roaming\\npm\\rushr-mcp.cmd")]) {
      expect(knownServerId(t), JSON.stringify(t.mcp)).toBe("rushr");
    }
  });

  it("ignores look-alikes", () => {
    for (const t of [
      local("npx", ["-y", "@rushr/mcp-pro"]),
      local("npx", ["-y", "@rushr-dev/mcp"]),
      local("npx", ["-y", "x@rushr/mcp"]),
      local("npx", ["-y", "@rushr/mcp@https://evil.example/pkg.tgz"]),
      local("rushr-mcp-fake"),
      local("not-rushr-mcp")
    ]) {
      expect(knownServerId(t), JSON.stringify(t.mcp)).toBeNull();
    }
  });

  it("~/.rushr and wallet files are protected wherever they are", () => {
    for (const p of ["/home/a/.rushr/agent-wallet.json", "/home/a/.rushr/ledger.json", "/home/a/project/.agent-wallet.json", "/home/a/project/agent-wallet.json", "C:\\Users\\a\\.rushr\\agent-wallet.json"]) {
      expect(isKeyMaterialPath(p), p).toBe(true);
    }
    for (const p of ["/home/a/project/agent-wallet.json.md", "/home/a/rushr/notes.md", "/home/a/project/my-agent-wallet.json"]) expect(isKeyMaterialPath(p), p).toBe(false);
  });
});

describe("Rushr wording", () => {
  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/rushr-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner\b/i, /airdrop/i, /token launch/i, /supports rushr/i, /rushr integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(/(?<!Robin)Hood Chain/.test(text)).toBe(false);
  });
});

describe("Rushr in the short preview", () => {
  it("the default CLI preview shows that a moved server trades real money", async () => {
    const { summaryText } = await import("../../apps/cli/src/format");
    const src = buildClaudeCodeRushr(rr);
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "claude-code", root: src, nativeId: "main" }, destination: { adapter: "codex", root: emptyDir(env.home, "sp/.codex") } });
    const text = summaryText(plan).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain('Warning: "rushr" trades real ETH on Robinhood Chain mainnet (4663): up to $5 per buy and $20 per 24 hours.');
    expect(text).toContain("Warning: Rushr: if Codex runs on another computer, the wallet and its API key do not come along");
  });
});
