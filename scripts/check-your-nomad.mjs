#!/usr/bin/env node
// Checks Your Nomad with the real Codex CLI, Gemini CLI and OpenClaw, in a throwaway home:
// 1. nomad connect adds Nomad's server to each app, and each app lists it as written.
// 2. The server starts with the exact command written for Codex, answers as an MCP server, knows it runs
//    in Codex, and shows the home.
// 3. nomad connect --remove takes it out again, and Codex's config.toml is back to the same bytes.
// Run after `pnpm build:cli`, with codex, gemini and openclaw on PATH or in NOMAD_APPS_BIN.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/nomad.js");
const bin = (name) => (process.env.NOMAD_APPS_BIN ? join(process.env.NOMAD_APPS_BIN, name) : name);
const home = mkdtempSync(join(tmpdir(), "nomad-home-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, NOMAD_FAKE_HOME: home, NOMAD_HOME: join(home, ".nomad"), CODEX_HOME: join(home, ".codex"), NO_COLOR: "1", CI: "1" };
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `\n     ${String(detail).trim().split("\n").join("\n     ")}` : ""}`);
  if (!ok) failed++;
};
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: home, env, encoding: "utf8", timeout: 180000 });
  return { code: r.status, out: r.stdout ?? "", err: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
};
const json = (text) => {
  const i = text.search(/[[{]/);
  try {
    return i < 0 ? undefined : JSON.parse(text.slice(i));
  } catch {
    return undefined;
  }
};
const codexServers = () => Object.fromEntries((json(run(bin("codex"), ["mcp", "list", "--json"]).out) ?? []).map((s) => [s.name, s]));

const TOML = `# My Codex settings
model = "gpt-5-codex"

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]
`;

try {
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".gemini"), { recursive: true });
  mkdirSync(join(home, ".openclaw"), { recursive: true });
  writeFileSync(join(home, ".codex/config.toml"), TOML);
  writeFileSync(join(home, ".codex/AGENTS.md"), "# Working agreements\n\n- Prefer small, reviewable commits.\n");
  writeFileSync(join(home, ".gemini/settings.json"), "{}\n");
  writeFileSync(join(home, ".openclaw/openclaw.json"), "{}\n");

  const c = run(process.execPath, [cli, "connect", "--app", "codex,gemini-cli,openclaw", "--yes"]);
  check("nomad connect adds Nomad to Codex, Gemini CLI and OpenClaw", c.code === 0, c.out + c.err);

  const codex = codexServers();
  check("codex lists the nomad server with the command Nomad wrote", codex.nomad?.transport?.command === process.execPath && JSON.stringify(codex.nomad?.transport?.args) === JSON.stringify([cli, "mcp", "--app", "codex"]), JSON.stringify(codex.nomad));
  check("codex still lists the docs server", codex.docs?.transport?.command === "npx", JSON.stringify(codex.docs));
  let skill = "";
  try {
    skill = readFileSync(join(home, ".codex/skills/nomad/SKILL.md"), "utf8");
  } catch {
    /* checked below */
  }
  check("the nomad skill is in Codex's skills", skill.includes("name: nomad"));

  const g = run(bin("gemini"), ["mcp", "list"]);
  check("gemini lists the nomad server", (g.out + g.err).includes(`nomad: ${process.execPath} ${cli} mcp --app gemini-cli (stdio)`), g.out + g.err);

  const v = run(bin("openclaw"), ["config", "validate"]);
  check("openclaw accepts its config", v.code === 0, v.out + v.err);
  const o = run(bin("openclaw"), ["mcp", "list", "--json"]);
  check("openclaw lists the nomad server", (json(o.out) ?? {}).nomad?.command === process.execPath, o.out + o.err);

  // The server, started exactly as Codex will start it.
  const entry = codex.nomad?.transport ?? { command: process.execPath, args: [cli, "mcp", "--app", "codex"] };
  const client = new Client({ name: "nomad-check", version: "1.0" });
  try {
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env, cwd: home, stderr: "pipe" }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["show_agents", "gather_agents", "borrow_agent", "bring_agent", "send_back", "apply_send_back"]) check(`the server offers ${n}`, tools.includes(n), tools.join(", "));
    check("the server tells the app how to use it", (client.getInstructions() ?? "").includes("borrow_agent"));
    const shown = await client.callTool({ name: "show_agents", arguments: {} });
    const data = json(shown.content?.[0]?.text ?? "") ?? {};
    check("show_agents knows it runs in Codex", data.app === "Codex CLI", JSON.stringify(data));
    check("show_agents finds the Codex agent to gather", (data.notInHomeYet ?? []).some((a) => a.app === "Codex CLI"), JSON.stringify(data.notInHomeYet));
    await client.callTool({ name: "gather_agents", arguments: {} });
    const borrowed = await client.callTool({ name: "borrow_agent", arguments: { agent: "Codex (user)" } });
    check("borrow_agent returns the agent's rules", (borrowed.content?.[0]?.text ?? "").includes("Prefer small, reviewable commits."), borrowed.content?.[0]?.text);
  } catch (e) {
    check("the server starts and answers", false, String(e));
  } finally {
    await client.close().catch(() => undefined);
  }

  const r = run(process.execPath, [cli, "connect", "--remove", "--app", "codex,gemini-cli,openclaw", "--yes"]);
  check("nomad connect --remove takes Nomad out", r.code === 0, r.out + r.err);
  check("codex no longer lists nomad", !codexServers().nomad);
  check("config.toml is back to the same bytes", readFileSync(join(home, ".codex/config.toml"), "utf8") === TOML);
  check("gemini no longer lists nomad", !run(bin("gemini"), ["mcp", "list"]).out.includes("nomad:"));
  check("openclaw no longer lists nomad", !(json(run(bin("openclaw"), ["mcp", "list", "--json"]).out) ?? {}).nomad);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nYour Nomad checks passed.");
process.exit(failed ? 1 : 0);
