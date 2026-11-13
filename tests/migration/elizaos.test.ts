import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { hasSecretsKey } from "@nomad/adapters";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { ELIZA_SECRET_VALUES, FAKE_PRIORS_SECRETS, buildClaudeCodePriors, buildElizaOSPriors } from "../fixtures/priors";

let env: Env;
let project: string;
let ph: string;
beforeEach(() => {
  env = setup();
  ph = join(env.home, "eh");
  mkdirSync(ph, { recursive: true });
  project = buildElizaOSPriors(ph);
});
afterEach(() => env.cleanup());

async function move(source: { adapter: string; root: string; nativeId: string }, dest: { adapter: string; root: string }) {
  const plan = await env.nomad.plan({ source: { kind: "location", ...source }, destination: dest });
  expect(plan.blocked).toEqual([]);
  const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
  expect(receipt.status, receipt.verification.filter((v) => !v.ok).map((v) => v.name).join(", ")).toBe("success");
  for (const v of [...FAKE_PRIORS_SECRETS, ...ELIZA_SECRET_VALUES]) expect((JSON.stringify(plan) + JSON.stringify(receipt)).includes(v)).toBe(false);
  return { plan, receipt };
}

const steps = (p: { manualSteps: string[] }) => p.manualSteps.join("\n");

describe("ElizaOS moves", () => {
  it("ElizaOS (MCP character) to Claude Code: limits as values, key as a reference", async () => {
    const dest = emptyDir(env.home, "e2c/.claude");
    const { plan } = await move({ adapter: "elizaos", root: project, nativeId: "priors-mcp" }, { adapter: "claude-code", root: dest });
    const s = JSON.parse(read(join(env.home, "e2c/.claude.json"))).mcpServers;
    expect(s["priors-wallet"].env.PRIORS_MAX_SPEND_DAY_USD).toBe("1");
    expect(s["priors-wallet"].env.PRIORS_PAY_HOSTS).toBe("api.example.com");
    expect(s["priors-wallet"].env.PRIORS_KEY_FILE).toBe("${PRIORS_KEY_FILE}");
    expect(s.priors).toEqual({ url: "https://mcp.priors.trade/mcp", type: "http" });
    expect(steps(plan)).toContain("PRIORS_KEY_FILE");
  });

  it("ElizaOS to Codex and Hermes", async () => {
    const cx = emptyDir(env.home, "e2x/.codex");
    await move({ adapter: "elizaos", root: project, nativeId: "priors-mcp" }, { adapter: "codex", root: cx });
    const t = parseToml(read(join(cx, "config.toml"))) as any;
    expect(t.mcp_servers["priors-wallet"].env_vars).toEqual(["PRIORS_KEY_FILE"]);
    const hm = emptyDir(env.home, "e2h/.hermes");
    await move({ adapter: "elizaos", root: project, nativeId: "priors-mcp" }, { adapter: "hermes", root: hm });
    const y = parseYaml(read(join(hm, "config.yaml"))) as any;
    expect(y.mcp_servers["priors-wallet"].env.PRIORS_KEY_FILE).toBe("${PRIORS_KEY_FILE}");
  });

  it("the style becomes conventions on Claude Code, the Priors plugin a hint", async () => {
    const dest = emptyDir(env.home, "e2c2/.claude");
    const { plan } = await move({ adapter: "elizaos", root: project, nativeId: "priors-agent" }, { adapter: "claude-code", root: dest });
    const md = read(join(dest, "CLAUDE.md"));
    expect(md).toContain("Style (chat)");
    expect(md).toContain("Answer the question first.");
    expect(steps(plan)).toContain("use the local MCP server priors-wallet (@priors/mcp)");
  });

  it("Claude Code to ElizaOS: servers under settings.mcp, no references, plugin and plain-text warnings", async () => {
    const src = buildClaudeCodePriors(join(env.home, "cc"));
    const dest = emptyDir(env.home, "c2e");
    const { plan } = await move({ adapter: "claude-code", root: src, nativeId: "main" }, { adapter: "elizaos", root: dest });
    const file = JSON.parse(readFileSync(join(dest, `characters/${plan.destination.nativeId}.json`), "utf8"));
    const servers = file.settings.mcp.servers;
    expect(servers["priors-wallet"]).toEqual({ type: "stdio", command: "npx", args: ["-y", "@priors/mcp@0.20.0"] });
    expect(servers["priors-hosted"]).toEqual({ type: "streamable-http", url: "https://mcp.priors.trade/mcp" });
    expect(JSON.stringify(file)).not.toContain("${");
    expect(hasSecretsKey(file)).toBe(false);
    expect(file.plugins).toEqual([]);
    expect(steps(plan)).toContain("@elizaos/plugin-mcp");
    expect(steps(plan)).toContain("plain text");
  });

  it("re-running changes nothing and the source is untouched", async () => {
    const hash = treeHash(project);
    const dest = emptyDir(env.home, "again/.claude");
    await move({ adapter: "elizaos", root: project, nativeId: "priors-agent" }, { adapter: "claude-code", root: dest });
    const again = await env.nomad.plan({ source: { kind: "location", adapter: "elizaos", root: project, nativeId: "priors-agent" }, destination: { adapter: "claude-code", root: dest } });
    expect(again.summary.create + again.summary.update).toBe(0);
    const e = emptyDir(env.home, "again-e");
    await move({ adapter: "elizaos", root: project, nativeId: "priors-agent" }, { adapter: "elizaos", root: e });
    const again2 = await env.nomad.plan({ source: { kind: "location", adapter: "elizaos", root: project, nativeId: "priors-agent" }, destination: { adapter: "elizaos", root: e } });
    expect(again2.summary.create + again2.summary.update).toBe(0);
    expect(treeHash(project)).toBe(hash);
  });
});
