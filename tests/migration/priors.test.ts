import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_KEY_FILE_CONTENTS, FAKE_PRIORS_SECRETS, buildClaudeCodePriors, buildCodexPriors, buildCursorPriors, buildGeminiPriors, buildHermesPriors } from "../fixtures/priors";

/**
 * Priors setups (a credit service for agents on Robinhood Chain) moving
 * between platforms. Fixtures follow Priors' own documentation; keys are fake.
 */

let env: Env;
let ph: string; // a separate fake home for the Priors fixtures
beforeEach(() => {
  env = setup();
  ph = join(env.home, "ph");
  mkdirSync(ph, { recursive: true });
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
  for (const t of texts) for (const s of [...FAKE_PRIORS_SECRETS, FAKE_KEY_FILE_CONTENTS.trim()]) expect(t.includes(s), `leaked a ${s.length} character secret`).toBe(false);
}

const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");
const items = (plan: { unsupported: Array<{ item: string; reason: string }> }) => plan.unsupported.map((u) => `${u.item}: ${u.reason}`).join("\n");

describe("Priors setups", () => {
  it("Claude Code to Codex: references forwarded, hosted servers deduplicated, plugin skill copied", async () => {
    const src = buildClaudeCodePriors(ph);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "codex", root: dest });
    const text = read(join(dest, "config.toml"));
    const cfg = parseToml(text) as any;
    expect(text).not.toContain("${");
    const wallet = cfg.mcp_servers["priors-wallet"];
    expect(wallet.command).toBe("npx");
    expect(wallet.args).toEqual(["-y", "@priors/mcp@0.20.0"]);
    expect(wallet.env_vars).toContain("PRIORS_KEY");
    expect(wallet.env_vars).toContain("PRIORS_AGENT_ID");
    expect(cfg.mcp_servers["priors-keyfile"].args).toEqual(["-c", 'read -r PRIORS_KEY < "$1" && export PRIORS_KEY && exec npx -y @priors/mcp@0.20.0', "priors-mcp", "~/.config/priors/agent.key"]);
    expect(items(plan) + steps(plan)).toContain("~/.config/priors/agent.key");
    // The plugin's priors-read and the user's priors-hosted are the same server: one entry, url only.
    expect(cfg.mcp_servers["priors-hosted"]).toEqual({ url: "https://mcp.priors.trade/mcp" });
    expect(cfg.mcp_servers["priors-read"]).toBeUndefined();
    expect(existsSync(join(dest, "skills/priors/SKILL.md"))).toBe(true);
    expect(steps(plan)).toContain("installed plugin read, not installed");
    // The symlink into the wallet folder was not followed, and the read says so.
    // (Windows runners may not allow creating the symlink; then there is nothing to skip.)
    if (existsSync(join(src, "skills/notes/NOTES.md"))) expect(plan.notes.some((n) => /can hold wallet keys/.test(n.message))).toBe(true);
    expect(existsSync(join(dest, "skills/notes/NOTES.md"))).toBe(false);
    expect(plan.notes.some((n) => /stay with the wallet/.test(n.message))).toBe(true);
    expectNoLeak(JSON.stringify(plan), JSON.stringify(receipt), allText(dest));
  });

  it("Codex to Hermes: key file as a reference, limits carried as values, .env untouched", async () => {
    const src = buildCodexPriors(ph);
    const dest = emptyDir(env.home, "x2h/.hermes");
    writeFileSync(join(dest, "config.yaml"), "# my Hermes settings\nterminal:\n  backend: local # keep this comment\n");
    writeFileSync(join(dest, ".env"), "OPENROUTER_API_KEY=keep-me\n");
    const envBefore = read(join(dest, ".env"));
    const { plan, receipt } = await migrate({ adapter: "codex", root: src, nativeId: "main" }, { adapter: "hermes", root: dest });
    const yamlText = read(join(dest, "config.yaml"));
    const cfg = parseYaml(yamlText) as any;
    const w = cfg.mcp_servers["priors-wallet"];
    expect(w.env.PRIORS_KEY_FILE).toBe("${PRIORS_KEY_FILE}");
    expect(w.env.PRIORS_PAY_HOSTS).toBe("api.example.com");
    expect(w.env.PRIORS_MAX_SPEND_DAY_USD).toBe("1");
    expect(w.env.PRIORS_MAX_BORROW_DAY_USD).toBe("0");
    expect(w.env.PRIORS_AGENT_ID).toBe("7311");
    expect(cfg.mcp_servers["priors-hosted"]).toEqual({ url: "https://mcp.priors.trade/mcp" });
    expect(steps(plan)).toContain("~/.hermes/.env");
    expect(read(join(dest, ".env"))).toBe(envBefore);
    expect(yamlText).toContain("# keep this comment");
    // The disabled server on the source is not added as active.
    expect(cfg.mcp_servers["old-wallet"]).toBeUndefined();
    expect(items(plan)).toContain("old-wallet: Disabled on the source");
    expectNoLeak(JSON.stringify(plan), JSON.stringify(receipt), allText(dest));
  });

  it("Hermes to Claude Code: plugin servers and skill arrive, keys and reference-only limits do not", async () => {
    const src = buildHermesPriors(ph);
    const dest = emptyDir(env.home, "h2c/.claude");
    const { plan, receipt } = await migrate({ adapter: "hermes", root: src, nativeId: "default" }, { adapter: "claude-code", root: dest });
    const servers = JSON.parse(read(join(env.home, "h2c/.claude.json"))).mcpServers;
    expect(servers.priors).toEqual({ url: "https://mcp.priors.trade/mcp", type: "http" });
    // The plugin's wallet server listed both key variables as references: neither is written.
    const fromPlugin = servers["priors-wallet-plugin"];
    expect(fromPlugin.command).toBe("priors-mcp");
    expect(fromPlugin.env.PRIORS_KEY).toBeUndefined();
    expect(fromPlugin.env.PRIORS_KEY_FILE).toBeUndefined();
    expect(fromPlugin.env.PRIORS_AGENT_ID).toBe("${PRIORS_AGENT_ID:-}");
    for (const k of ["PRIORS_PAY_HOSTS", "PRIORS_MAX_SPEND_DAY_USD", "PRIORS_MAX_BORROW_DAY_USD", "PRIORS_MAX_PRICE_USD"]) expect(fromPlugin.env[k]).toBeUndefined();
    expect(steps(plan)).toMatch(/listed both PRIORS_KEY_FILE and PRIORS_KEY/);
    expect(steps(plan)).toContain("npm install -g @priors/mcp@<version you trust>");
    expect(items(plan)).toContain("priors-wallet-plugin: PRIORS_PAY_HOSTS: Limit not carried");
    expect(items(plan)).toContain("defaults are looser: any public https host");
    expect(items(plan)).toContain("defaults are looser: no daily caps");
    expect(items(plan)).toContain("trust: untrusted");
    // The wallet server from config.yaml had one key variable (a path, now a reference) and literal limits.
    const own = servers["priors-wallet"];
    expect(own.env.PRIORS_KEY_FILE).toBe("${PRIORS_KEY_FILE}");
    expect(own.env.PRIORS_PAY_HOSTS).toBe("api.example.com");
    // The disabled plugin's server is not written at all.
    expect(servers["priors-old"]).toBeUndefined();
    expect(existsSync(join(dest, "skills/priors/SKILL.md"))).toBe(true);
    expect(read(join(env.home, "h2c/.claude.json"))).not.toContain("agent-7311.key");
    expectNoLeak(JSON.stringify(plan), JSON.stringify(receipt), allText(join(env.home, "h2c")));
  });

  it("Claude Code to Gemini CLI: httpUrl, no unset references", async () => {
    const src = buildClaudeCodePriors(ph);
    const dest = emptyDir(env.home, "c2g/.gemini");
    const { plan } = await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "gemini-cli", root: dest });
    const text = read(join(dest, "settings.json"));
    const s = JSON.parse(text).mcpServers;
    expect(s["priors-hosted"]).toEqual({ httpUrl: "https://mcp.priors.trade/mcp" });
    expect(text).not.toContain("${PRIORS_AGENT_ID");
    expect(steps(plan)).toContain("PRIORS_AGENT_ID");
    expect(plan.unsupported.some((u) => u.category === "skills")).toBe(true);
  });

  it("Claude Code to Cursor: ${env:NAME} references", async () => {
    const src = buildClaudeCodePriors(ph);
    const dest = emptyDir(env.home, "c2cur");
    await migrate({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "cursor", root: dest });
    const s = JSON.parse(read(join(dest, ".cursor/mcp.json"))).mcpServers;
    expect(s["priors-wallet"].env.PRIORS_KEY).toBe("${env:PRIORS_KEY}");
    expect(s["priors-hosted"].url).toBe("https://mcp.priors.trade/mcp");
  });

  it("Hermes to Hermes (copy): plugin items are reinstalled, not copied", async () => {
    const src = buildHermesPriors(ph);
    const before = read(join(src, "config.yaml"));
    const { plan } = await migrate({ adapter: "hermes", root: src, nativeId: "default" }, { adapter: "hermes", root: src }, { mode: "copy" });
    const profile = readdirSync(join(src, "profiles"))[0];
    const cfg = parseYaml(read(join(src, "profiles", profile, "config.yaml"))) as any;
    expect(Object.keys(cfg.mcp_servers)).toEqual(["priors-wallet"]);
    expect(existsSync(join(src, "profiles", profile, "skills/nomad-imports/priors"))).toBe(false);
    expect(steps(plan)).toContain('"hermes plugins install priors", then "hermes plugins enable priors"');
    expect(read(join(src, "config.yaml"))).toBe(before);
    expect(cfg.plugins).toBeUndefined();
  });

  it("never leaks keys anywhere, even with include-secrets, and leaves sources untouched", async () => {
    const builders: Array<[string, (h: string) => string, string]> = [
      ["claude-code", buildClaudeCodePriors, "main"],
      ["codex", buildCodexPriors, "main"],
      ["hermes", buildHermesPriors, "default"],
      ["cursor", buildCursorPriors, "main"],
      ["gemini-cli", buildGeminiPriors, "main"]
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
      // A .nomad export of the agent.
      const exp = await env.nomad.exportAgent({ kind: "location", adapter: id, root, nativeId }, { outPath: join(env.home, `exp-${id}.nomad`) });
      expectNoLeak(Buffer.from(exp.bytes).toString("latin1"), ...[...exp.files.values()].map((b) => Buffer.from(b).toString("utf8")));
      expect(treeHash(home), `${id} source unchanged`).toBe(hash);
    }
    expectNoLeak(allText(join(env.nomadHome, "backups")));
  });
});
