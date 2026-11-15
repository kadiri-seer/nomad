import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import { isKeyMaterialPath } from "@nomad/core/node";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import {
  FAKE_BC_PAYER_KEY,
  FAKE_BC_SECRETS,
  buildClaudeCodeBrainChain,
  buildCodexBrainChain,
  buildCursorBrainChain,
  buildGeminiBrainChain,
  buildHermesBrainChain,
  buildOpenClawBrainChain
} from "../fixtures/brainchain";

/**
 * BrainChain setups (verified AI work, paid on Robinhood Chain or Base) moving between platforms,
 * mostly on mainnet. Fixtures follow BrainChain's docs and repositories; keys are fake.
 */

let env: Env;
let bc: string;
beforeEach(() => {
  env = setup();
  bc = join(env.home, "bc");
  mkdirSync(bc, { recursive: true });
});
afterEach(() => env.cleanup());

type Loc = { adapter: string; root: string; nativeId: string };

async function migrate(source: Loc, dest: { adapter: string; root: string; nativeId?: string }, opts: { includeSecrets?: boolean } = {}) {
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
  for (const t of texts) for (const s of FAKE_BC_SECRETS) expect(t.includes(s), `leaked a ${s.length} character secret`).toBe(false);
}

const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");
const items = (plan: { unsupported: Array<{ item: string; reason: string }> }) => plan.unsupported.map((u) => `${u.item}: ${u.reason}`).join("\n");
const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");

describe("BrainChain setups", () => {
  it("Claude Code to Codex: the mainnet entry arrives, the key file stays a reference, and the preview says what it pays", async () => {
    const src = buildClaudeCodeBrainChain(bc);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "codex", root: dest });
    const s = (parseToml(read(join(dest, "config.toml"))) as any).mcp_servers.brainchain;
    expect(s.command).toBe("npx");
    expect(s.args).toEqual(["-y", "brainchain-mcp@0.9.3"]);
    expect(s.env?.BRAINCHAIN_PAYER_KEY_FILE).toBeUndefined();
    expect(s.env_vars).toContain("BRAINCHAIN_PAYER_KEY_FILE");
    expect(warnings(plan)).toContain('"brainchain" pays on Robinhood Chain mainnet in real USDG: up to 1 USDG per task and 10 USDG per run.');
    expect(warnings(plan)).toContain('"brainchain" has no daily cap on Codex');
    expect(warnings(plan)).toContain("BrainChain: if Codex runs on another computer, the wallet key does not come along.");
    expect(notes(plan)).toContain("BrainChain's wallet key and daily spending record stay on this computer in ~/.brainchain.");
    expect(steps(plan)).toContain("BRAINCHAIN_PAYER_KEY_FILE=<key file> npx -y brainchain-mcp@0.9.3 approve");
    expect(steps(plan)).toContain("BRAINCHAIN_PAYER_KEY_FILE=<key file> npx -y brainchain-mcp@0.9.3 wallet");
    expect(steps(plan)).toContain("Node.js 22 or later");
    expectNoLeak(JSON.stringify(plan), JSON.stringify(receipt), allText(join(env.home, "c2x")));
  });

  it("Codex to Claude Code: a raw payer key is never written as a value, even with --include-secrets; limits carry", async () => {
    const src = buildCodexBrainChain(bc);
    for (const includeSecrets of [false, true]) {
      const dest = emptyDir(env.home, `x2c-${includeSecrets}/.claude`);
      const { plan, receipt } = await migrate({ adapter: "codex", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest }, { includeSecrets });
      const e = JSON.parse(read(join(env.home, `x2c-${includeSecrets}/.claude.json`))).mcpServers.brainchain.env;
      expect(e.BRAINCHAIN_PAYER_KEY).toBe("${BRAINCHAIN_PAYER_KEY}");
      expect(e.BRAINCHAIN_BUDGET_UNITS).toBe("3000000");
      expect(e.BRAINCHAIN_DAILY_UNITS).toBe("3000000");
      expect(warnings(plan)).toContain("up to 1 USDG per task and 3 USDG per run.");
      expect(warnings(plan)).not.toContain("has no daily cap");
      expect(notes(plan)).toContain("BrainChain recommends BRAINCHAIN_PAYER_KEY_FILE instead");
      expectNoLeak(JSON.stringify(plan), JSON.stringify(receipt), allText(join(env.home, `x2c-${includeSecrets}`)));
    }
  });

  it("Cursor to Gemini CLI: paying in USDC on Base is named, and no USDG approval is listed", async () => {
    const src = buildCursorBrainChain(bc);
    const dest = emptyDir(env.home, "cur2g/.gemini");
    const { plan } = await migrate({ adapter: "cursor", root: src, nativeId: "main" }, { adapter: "gemini-cli", root: dest });
    const g = JSON.parse(read(join(dest, "settings.json"))).mcpServers.brainchain;
    expect(g.env.BRAINCHAIN_PAY_ON).toBe("base");
    expect(g.env.BRAINCHAIN_DAILY_UNITS).toBe("5000000");
    expect(warnings(plan)).toContain('"brainchain" pays on Base mainnet in real USDC: up to 1 USDC per task and 10 USDC per run.');
    expect(steps(plan)).not.toContain(" approve");
    expect(steps(plan)).toContain("BRAINCHAIN_PAY_ON=base BRAINCHAIN_PAYER_KEY_FILE=<key file> npx -y brainchain-mcp@0.9.3 wallet");
  });

  it("Gemini CLI to Claude Code: the testnet is a note, and the global command needs installing", async () => {
    const src = buildGeminiBrainChain(bc);
    const dest = emptyDir(env.home, "g2c/.claude");
    const { plan } = await migrate({ adapter: "gemini-cli", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest });
    expect(JSON.parse(read(join(env.home, "g2c/.claude.json"))).mcpServers.brainchain.command).toBe("brainchain-mcp");
    expect(notes(plan)).toContain('"brainchain" uses the BrainChain testnet and pays in test USDG on the Robinhood Chain testnet.');
    expect(warnings(plan)).not.toContain("mainnet in real");
    expect(steps(plan)).toContain("npm install -g brainchain-mcp");
    expect(steps(plan)).toContain("BRAINCHAIN_NETWORK=testnet BRAINCHAIN_PAYER_KEY_FILE=<key file> npx -y brainchain-mcp approve");
  });

  it("Hermes to Claude Code: a network that is a variable is explained, a daily cap that is a variable is not carried", async () => {
    const src = buildHermesBrainChain(bc);
    const dest = emptyDir(env.home, "h2c/.claude");
    const { plan } = await migrate({ adapter: "hermes", root: src, nativeId: "default" }, { adapter: "claude-code", root: dest });
    const e = JSON.parse(read(join(env.home, "h2c/.claude.json"))).mcpServers.brainchain.env ?? {};
    expect(e.BRAINCHAIN_DAILY_UNITS).toBeUndefined();
    expect(items(plan)).toContain("brainchain: BRAINCHAIN_DAILY_UNITS: Limit not carried: it was a reference on the source, so the destination uses BrainChain defaults (no daily cap).");
    expect(warnings(plan)).toContain('"brainchain" takes its network from BRAINCHAIN_NETWORK, which was a variable on the source. BrainChain uses mainnet (real money) unless it is set to testnet on Claude Code.');
    expect(warnings(plan)).toContain('"brainchain" has no daily cap on Claude Code');
    expect(steps(plan)).toContain('"brainchain" can only pay with its wallet key: make sure BRAINCHAIN_PAYER_KEY_FILE is set for it on Claude Code. Without it the server starts and reads, but cannot post or bond tasks.');
  });

  it("OpenClaw to Claude Code: the server and both skills arrive, and the preview says the skills are written for OpenClaw", async () => {
    const src = buildOpenClawBrainChain(bc);
    const dest = emptyDir(env.home, "o2c/.claude");
    const { plan, receipt } = await migrate({ adapter: "openclaw", root: src, nativeId: "main" }, { adapter: "claude-code", root: dest });
    const s = JSON.parse(read(join(env.home, "o2c/.claude.json"))).mcpServers.brainchain;
    expect(s.args).toEqual(["-y", "brainchain-mcp@0.9.3"]);
    expect(s.env).toMatchObject({ BRAINCHAIN_PAY_ON: "base", BRAINCHAIN_BUDGET_UNITS: "5000000", BRAINCHAIN_DAILY_UNITS: "5000000", BRAINCHAIN_PAYER_KEY_FILE: "${BRAINCHAIN_PAYER_KEY_FILE}" });
    expect(existsSync(join(dest, "skills/brainchain/SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "skills/brainchain-worker/SKILL.md"))).toBe(true);
    expect(warnings(plan)).toContain('The "brainchain-worker" skill is written for OpenClaw: it needs the openclaw command, Docker and its key in OpenClaw\'s secrets settings, so it does not work on Claude Code as it is.');
    expect(notes(plan)).toContain('The "brainchain" skill is written for OpenClaw');
    expect(warnings(plan)).toContain("up to 1 USDC per task and 5 USDC per run.");
    expectNoLeak(JSON.stringify(plan), JSON.stringify(receipt), allText(join(env.home, "o2c")));
  });

  it("Claude Code to OpenClaw: the server goes to mcp.servers with no reference, and the step says how to set the key file", async () => {
    const src = buildClaudeCodeBrainChain(bc);
    const oc = emptyDir(env.home, "c2o/.openclaw");
    const { plan } = await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "openclaw", root: oc });
    const text = read(join(oc, "openclaw.json"));
    expect(text.includes("${")).toBe(false);
    expect(JSON5.parse(text).mcp.servers.brainchain).toEqual({ command: "npx", args: ["-y", "brainchain-mcp@0.9.3"] });
    expect(steps(plan)).toContain('Set BRAINCHAIN_PAYER_KEY_FILE for the "brainchain" MCP server in OpenClaw: openclaw config set mcp.servers.brainchain.env.BRAINCHAIN_PAYER_KEY_FILE <value>');
    expect(warnings(plan)).toContain('"brainchain" pays on Robinhood Chain mainnet in real USDG');
  });

  it("OpenClaw to OpenClaw: the worker skill's key setup is named as something to redo", async () => {
    const src = buildOpenClawBrainChain(bc);
    const oc = emptyDir(env.home, "o2o/.openclaw");
    const { plan } = await migrate({ adapter: "openclaw", root: src, nativeId: "main" }, { adapter: "openclaw", root: oc });
    expect(warnings(plan)).toContain('The "brainchain-worker" skill reads its key through OpenClaw\'s secrets settings, which Nomad does not copy');
    expect(notes(plan)).not.toContain('The "brainchain" skill is written for OpenClaw');
    const cfg = JSON5.parse(read(join(oc, "openclaw.json")));
    expect(cfg.mcp.servers.brainchain.env).toEqual({ BRAINCHAIN_PAY_ON: "base", BRAINCHAIN_BUDGET_UNITS: "5000000", BRAINCHAIN_DAILY_UNITS: "5000000" });
    expect(cfg.secrets).toBeUndefined();
  });

  it("never leaks a key anywhere, even with include-secrets, and leaves sources and ~/.brainchain untouched", async () => {
    const builders: Array<[string, (h: string) => string, string]> = [
      ["claude-code", buildClaudeCodeBrainChain, "main"],
      ["codex", buildCodexBrainChain, "main"],
      ["hermes", buildHermesBrainChain, "default"],
      ["cursor", buildCursorBrainChain, "main"],
      ["gemini-cli", buildGeminiBrainChain, "main"],
      ["openclaw", buildOpenClawBrainChain, "main"]
    ];
    const dests: Array<[string, (n: string) => string]> = [
      ["claude-code", (n) => emptyDir(env.home, `${n}/.claude`)],
      ["codex", (n) => emptyDir(env.home, `${n}/.codex`)],
      ["hermes", (n) => emptyDir(env.home, `${n}/.hermes`)],
      ["openclaw", (n) => emptyDir(env.home, `${n}/.openclaw`)]
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
      for (const includeSecrets of [false, true]) {
        const exp = await env.nomad.exportAgent({ kind: "location", adapter: id, root, nativeId }, { outPath: join(env.home, `exp-${id}-${includeSecrets}.nomad`), includeSecrets });
        expectNoLeak(Buffer.from(exp.bytes).toString("latin1"), ...[...exp.files.values()].map((b) => Buffer.from(b).toString("utf8")));
      }
      expect(treeHash(home), `${id} source and ~/.brainchain unchanged`).toBe(hash);
    }
    expectNoLeak(allText(join(env.nomadHome, "backups")));
  });
});

describe("BrainChain wording", () => {
  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/brainchain-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner\b/i, /airdrop/i, /token launch/i, /supports brainchain/i, /brainchain integration/i]) expect(re.test(text), String(re)).toBe(false);
    expect(/(?<!Robin)Hood Chain/.test(text)).toBe(false);
  });
});

describe("BrainChain profile", () => {
  const tool = (command: string, args: string[], extra: Record<string, unknown> = {}) => ({ name: "x", kind: "mcp", mcp: { transport: "stdio", command, args, env: {}, headers: {}, ...extra } }) as any;

  it("recognises every documented way of running BrainChain's server, and nothing else", () => {
    for (const t of [
      tool("npx", ["-y", "brainchain-mcp"]),
      tool("npx", ["-y", "brainchain-mcp@0.9.3"]),
      tool("brainchain-mcp", []),
      tool("/usr/local/bin/brainchain-mcp", []),
      tool("C:\\Users\\ada\\AppData\\Roaming\\npm\\brainchain-mcp.cmd", [])
    ]) expect(knownServerId(t), JSON.stringify(t.mcp)).toBe("brainchain");
    for (const t of [tool("npx", ["-y", "brainchain-worker", "run"]), tool("brainchain-worker", ["run"]), tool("npx", ["-y", "brainchain-mcp-proxy"]), tool("npx", ["-y", "@evil/brainchain-mcp"])]) {
      expect(knownServerId(t), JSON.stringify(t.mcp)).not.toBe("brainchain");
    }
  });

  it("turns a raw payer key into a reference and leaves the source tool unchanged", () => {
    const t = tool("npx", ["-y", "brainchain-mcp@0.9.3"], { env: { BRAINCHAIN_PAYER_KEY: { value: FAKE_BC_PAYER_KEY }, BRAINCHAIN_PAY_ON: { value: "base" } } });
    const before = JSON.stringify(t);
    const out = applyKnownServerProfile(t, "Codex");
    expect(JSON.stringify(t)).toBe(before);
    expect(out.tool.mcp!.env.BRAINCHAIN_PAYER_KEY).toEqual({ secretRef: "BRAINCHAIN_PAYER_KEY", redacted: true });
    expect(out.tool.mcp!.env.BRAINCHAIN_PAY_ON).toEqual({ value: "base" });
  });

  it("writes neither key when both the key and the key file are set, as the server refuses both", () => {
    const t = tool("npx", ["-y", "brainchain-mcp"], { env: { BRAINCHAIN_PAYER_KEY: { secretRef: "BRAINCHAIN_PAYER_KEY", redacted: true }, BRAINCHAIN_PAYER_KEY_FILE: { secretRef: "BRAINCHAIN_PAYER_KEY_FILE", redacted: true } } });
    const out = applyKnownServerProfile(t, "Codex");
    expect(out.tool.mcp!.env.BRAINCHAIN_PAYER_KEY).toBeUndefined();
    expect(out.tool.mcp!.env.BRAINCHAIN_PAYER_KEY_FILE).toBeUndefined();
    expect(out.manualSteps.join("\n")).toContain("listed both BRAINCHAIN_PAYER_KEY_FILE and BRAINCHAIN_PAYER_KEY");
  });

  it("keeps the BrainChain folders off-limits, and the other profiles unchanged", () => {
    for (const p of ["/home/a/.brainchain/payer.key", "/home/a/.brainchain/worker.key", "/home/a/.brainchain", "/home/a/.config/brainchain-worker/state.json"]) expect(isKeyMaterialPath(p), p).toBe(true);
    expect(isKeyMaterialPath("/home/a/brainchain-notes/plan.md")).toBe(false);
    expect(knownServerId(tool("npx", ["-y", "@hedgehood-io/mcp"]))).toBe("hedgehood");
    expect(knownServerId(tool("oak", ["mcp"]))).toBe("oak");
    expect(knownServerId(tool("npx", ["-y", "@priors/mcp@0.20.0"]))).toBe("priors");
  });
});
