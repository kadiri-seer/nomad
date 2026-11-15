import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";

/**
 * OpenClaw keeps MCP servers in openclaw.json under mcp.servers, shared by all its agents
 * (docs.openclaw.ai/gateway/config-extensions). Nomad reads and writes them. References are
 * never written there, because an older OpenClaw refuses to load a config with an unset ${VAR}.
 */

let env: Env;
beforeEach(() => (env = setup()));
afterEach(() => env.cleanup());

const FAKE_API_KEY = "sk-proj-" + "Qa1Ws2Ed3Rf4Tg5Yh6Uj7Ik8Ol9Pz0Xc1Vb2";
const put = (p: string, s: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};
const allText = (dir: string): string => {
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
};

/** An OpenClaw with servers the way `openclaw mcp set` and the docs write them. */
function openclawWithServers(home: string) {
  const r = join(home, ".openclaw");
  put(
    join(r, "openclaw.json"),
    `// OpenClaw configuration
{
  agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } } },
  mcp: {
    servers: {
      fetch: { command: "uvx", args: ["mcp-server-fetch"] },
      memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: { MEMORY_FILE: "~/notes/memory.json", OPENAI_API_KEY: "${FAKE_API_KEY}" } },
      docs: { url: "https://mcp.example.com/mcp", transport: "streamable-http", headers: { Authorization: "Bearer \${DOCS_TOKEN}" } },
      legacy: { url: "https://old.example.com/sse" },
      vault: { command: "node", args: ["vault.js"], env: { VAULT_TOKEN: { source: "env", provider: "default", id: "VAULT_TOKEN" } } },
      paused: { command: "node", args: ["paused.js"], enabled: false },
    },
  },
}
`
  );
  put(join(r, "workspace/AGENTS.md"), "# AGENTS.md\n\n- Be brief.\n");
  put(join(r, "workspace/SOUL.md"), "You are Wren.\n");
  return r;
}

describe("OpenClaw MCP servers", () => {
  it("reads mcp.servers: local and remote servers, references, OpenClaw's SSE default and switched-off servers", async () => {
    const root = openclawWithServers(join(env.home, "a"));
    const r = await env.nomad.readLocation("openclaw", root, "main", { register: false });
    const byName = Object.fromEntries(r.doc.tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["docs", "fetch", "legacy", "memory", "paused", "vault"]);
    expect(byName.fetch.mcp).toMatchObject({ transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] });
    expect(byName.memory.mcp!.env.MEMORY_FILE).toEqual({ value: "~/notes/memory.json" });
    // A literal API key is never kept: it becomes a reference.
    expect(byName.memory.mcp!.env.OPENAI_API_KEY).toEqual({ secretRef: "OPENAI_API_KEY", redacted: true });
    expect(byName.docs.mcp).toMatchObject({ transport: "http", url: "https://mcp.example.com/mcp" });
    expect(byName.legacy.mcp!.transport).toBe("sse");
    expect(byName.vault.mcp!.env.VAULT_TOKEN).toEqual({ secretRef: "VAULT_TOKEN", redacted: true });
    expect(byName.paused.enabled).toBe(false);
    expect(JSON.stringify(r.doc).includes(FAKE_API_KEY)).toBe(false);
  });

  it("OpenClaw to Claude Code: every server arrives, in Claude Code's format", async () => {
    const root = openclawWithServers(join(env.home, "b"));
    const hash = treeHash(root);
    const dest = emptyDir(env.home, "b-cc/.claude");
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "openclaw", root, nativeId: "main" }, destination: { adapter: "claude-code", root: dest } });
    expect(plan.blocked).toEqual([]);
    const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
    expect(receipt.status).toBe("success");
    const s = JSON.parse(read(join(env.home, "b-cc/.claude.json"))).mcpServers;
    expect(Object.keys(s).sort()).toEqual(["docs", "fetch", "legacy", "memory", "vault"]);
    expect(s.memory.env).toEqual({ MEMORY_FILE: "~/notes/memory.json", OPENAI_API_KEY: "${OPENAI_API_KEY}" });
    expect(s.docs).toMatchObject({ type: "http", url: "https://mcp.example.com/mcp" });
    expect(s.legacy).toMatchObject({ type: "sse", url: "https://old.example.com/sse" });
    expect(allText(join(env.home, "b-cc")).includes(FAKE_API_KEY)).toBe(false);
    expect(treeHash(root)).toBe(hash);
  });

  it("Claude Code to OpenClaw: servers go to mcp.servers with no references, and the steps say how to set them", async () => {
    const cc = join(env.home, "c/.claude");
    put(join(cc, "CLAUDE.md"), "# Rules\n\n- Be brief.\n");
    put(
      join(env.home, "c/.claude.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}", GITHUB_API_URL: "https://api.github.com" } },
          search: { type: "http", url: "https://mcp.search.example/mcp", headers: { "X-Api-Key": "${SEARCH_KEY}" } },
          events: { type: "sse", url: "https://events.example/sse" }
        }
      })
    );
    const oc = join(env.home, "c-oc/.openclaw");
    put(join(oc, "openclaw.json"), `{ mcp: { servers: { mine: { command: "node", args: ["mine.js"] } } } }\n`);
    put(join(oc, "workspace/AGENTS.md"), "# AGENTS.md\n");
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "claude-code", root: cc, nativeId: "main" }, destination: { adapter: "openclaw", root: oc } });
    expect(plan.blocked).toEqual([]);
    const steps = plan.manualSteps.join("\n");
    expect(steps).toContain('Set GITHUB_PERSONAL_ACCESS_TOKEN for the "github" MCP server in OpenClaw: openclaw config set mcp.servers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN <value>');
    expect(steps).toContain('Set the X-Api-Key header for the "search" MCP server in OpenClaw: openclaw config set mcp.servers.search.headers.X-Api-Key <value>');
    expect(steps).not.toContain("MCP plugin");
    expect(plan.notes.map((n) => n.message).join("\n")).toContain('OpenClaw\'s MCP servers are shared by all its agents, so "github", "search", "events" will also be available to the other agents of this OpenClaw.');
    const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
    expect(receipt.status, receipt.verification.filter((v) => !v.ok).map((v) => v.name).join()).toBe("success");
    expect(receipt.verification.find((v) => v.name === "MCP servers written")?.ok).toBe(true);
    const text = read(join(oc, "openclaw.json"));
    expect(text.includes("${")).toBe(false);
    const servers = JSON5.parse(text).mcp.servers;
    expect(servers.mine).toEqual({ command: "node", args: ["mine.js"] });
    expect(servers.github).toEqual({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_API_URL: "https://api.github.com" } });
    expect(servers.search).toEqual({ url: "https://mcp.search.example/mcp", transport: "streamable-http" });
    expect(servers.events).toEqual({ url: "https://events.example/sse", transport: "sse" });

    // Moving the same agent again changes nothing.
    const again = await env.nomad.plan({ source: { kind: "location", adapter: "claude-code", root: cc, nativeId: "main" }, destination: { adapter: "openclaw", root: oc } });
    expect(again.summary.create + again.summary.update).toBe(0);
  });

  it("OpenClaw to OpenClaw: the servers carry over, switched-off ones stay behind", async () => {
    const root = openclawWithServers(join(env.home, "d"));
    const oc = join(env.home, "d-oc/.openclaw");
    put(join(oc, "workspace/AGENTS.md"), "# AGENTS.md\n");
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "openclaw", root, nativeId: "main" }, destination: { adapter: "openclaw", root: oc } });
    expect(plan.blocked).toEqual([]);
    expect(plan.unsupported.map((u) => u.item)).toContain("paused");
    const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
    expect(receipt.status).toBe("success");
    const servers = JSON5.parse(read(join(oc, "openclaw.json"))).mcp.servers;
    expect(Object.keys(servers).sort()).toEqual(["docs", "fetch", "legacy", "memory", "vault"]);
    expect(servers.legacy.transport).toBe("sse");
    expect(servers.docs.transport).toBe("streamable-http");
    expect(allText(join(env.home, "d-oc")).includes(FAKE_API_KEY)).toBe(false);
  });
});
