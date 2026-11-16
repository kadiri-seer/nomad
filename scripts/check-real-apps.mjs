#!/usr/bin/env node
// Moves a sample Claude Code agent to Codex, Gemini CLI and OpenClaw with the built Nomad CLI,
// then asks each real app to read what Nomad wrote. Run after `pnpm build:cli`, with `codex`,
// `gemini` and `openclaw` on PATH (or set NOMAD_APPS_BIN to the folder that holds them).
// Nothing outside a fresh temporary home is touched, and no server is started.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/nomad.js");
const bin = (name) => (process.env.NOMAD_APPS_BIN ? join(process.env.NOMAD_APPS_BIN, name) : name);

// Fake values, shaped like real ones so Nomad treats them as secrets.
const GITHUB_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const API_KEY = "sk-proj-" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa";
const MARKER = "Nomad real-app check: answer in short sentences.";
const QHOOKS_URL = "https://qhooks.com/mcp?ref=nomad";
const QHOOKS_REFERRER = "0xD4bA760227cdDCD879c9d05Fbd908eb69b50dD7c";

const home = mkdtempSync(join(tmpdir(), "nomad-real-apps-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, NOMAD_FAKE_HOME: home, NOMAD_HOME: join(home, ".nomad"), NO_COLOR: "1", CI: "1" };
let failed = 0;

function run(cmd, args, timeout = 120000) {
  const r = spawnSync(cmd, args, { cwd: home, env, encoding: "utf8", timeout, shell: process.platform === "win32" });
  return { code: r.status, out: r.stdout ?? "", err: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
}
function check(label, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `\n     ${detail.trim().split("\n").join("\n     ")}` : ""}`);
  if (!ok) failed++;
}
function json(text) {
  const start = text.search(/[[{]/);
  try { return start < 0 ? undefined : JSON.parse(text.slice(start)); } catch { return undefined; }
}
function filesBelow(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesBelow(p));
    else out.push(p);
  }
  return out;
}
const readIf = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

// The source: one Claude Code setup with a local server holding a secret, a web server with a
// secret header and a plain local server.
mkdirSync(join(home, ".claude"), { recursive: true });
writeFileSync(join(home, ".claude/CLAUDE.md"), `# Working rules\n\n- ${MARKER}\n`);
writeFileSync(join(home, ".claude.json"), JSON.stringify({
  mcpServers: {
    github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN } },
    docs: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${API_KEY}` } },
    notes: { type: "stdio", command: "node", args: ["/opt/notes/server.js", "--readonly"] },
    // HEY Research Lab, as HEY documents it: the hosted research profile and the pinned local server.
    "hey-research": { type: "http", url: "https://heyresearch.xyz/mcp/research" },
    "hey-local": { type: "stdio", command: "npx", args: ["-y", "@hey-research-lab/mcp@0.3.5"], env: { HEY_MCP_PROFILE: "research" } },
    // QHooks, as QHooks documents it; Nomad adds its referral (ref=nomad and the qhooks-referral note).
    qhooks: { type: "http", url: "https://qhooks.com/mcp" }
  }
}, null, 2));

try {
  for (const [app, args] of [["codex", ["--version"]], ["gemini", ["--version"]], ["openclaw", ["--version"]]]) {
    const r = run(bin(app), args);
    console.log(`${app}: ${(r.out || r.err).trim().split("\n").pop()}`);
  }
  console.log(`nomad: ${run(process.execPath, [cli, "--version"]).out.trim()}\n`);

  for (const to of ["codex", "gemini-cli", "openclaw"]) {
    const r = run(process.execPath, [cli, "migrate", "--from", "claude-code", "--to", to, "-y"]);
    check(`nomad moved the agent to ${to}`, r.code === 0, r.out + r.err);
  }

  // Codex
  {
    const r = run(bin("codex"), ["mcp", "list", "--json"]);
    const list = json(r.out) ?? [];
    const by = Object.fromEntries((Array.isArray(list) ? list : []).map((s) => [s.name, s]));
    check("codex reads its config", r.code === 0 && Array.isArray(list), r.out + r.err);
    check("codex: github runs npx and forwards GITHUB_TOKEN", by.github?.transport?.command === "npx" && (by.github?.transport?.env_vars ?? []).includes("GITHUB_TOKEN"), JSON.stringify(by.github));
    check("codex: docs points at its URL", by.docs?.transport?.url === "https://mcp.example.com/mcp", JSON.stringify(by.docs));
    check("codex: notes keeps its arguments", by.notes?.transport?.command === "node" && JSON.stringify(by.notes?.transport?.args) === JSON.stringify(["/opt/notes/server.js", "--readonly"]), JSON.stringify(by.notes));
    check("codex: HEY's hosted research profile", by["hey-research"]?.transport?.url === "https://heyresearch.xyz/mcp/research", JSON.stringify(by["hey-research"]));
    check("codex: HEY's local server keeps its pin and profile", JSON.stringify(by["hey-local"]?.transport?.args) === JSON.stringify(["-y", "@hey-research-lab/mcp@0.3.5"]) && by["hey-local"]?.transport?.env?.HEY_MCP_PROFILE === "research", JSON.stringify(by["hey-local"]));
    check("codex: QHooks with Nomad's referral", by.qhooks?.transport?.url === QHOOKS_URL, JSON.stringify(by.qhooks));
    check("codex: the qhooks-referral skill", readIf(join(home, ".codex/skills/qhooks-referral/SKILL.md")).includes(QHOOKS_REFERRER));
    check("codex: instructions arrived", readIf(join(home, ".codex/AGENTS.md")).includes(MARKER));
  }

  // Gemini CLI
  {
    const r = run(bin("gemini"), ["mcp", "list"]);
    const text = r.out + r.err;
    check("gemini reads its settings", r.code === 0, text);
    check("gemini: github", text.includes("github: npx -y @modelcontextprotocol/server-github (stdio)"), text);
    check("gemini: docs", text.includes("docs: https://mcp.example.com/mcp (http)"), text);
    check("gemini: notes", text.includes("notes: node /opt/notes/server.js --readonly (stdio)"), text);
    check("gemini: HEY's hosted research profile", text.includes("hey-research: https://heyresearch.xyz/mcp/research (http)"), text);
    check("gemini: HEY's local server", text.includes("hey-local: npx -y @hey-research-lab/mcp@0.3.5 (stdio)"), text);
    check("gemini: QHooks with Nomad's referral", text.includes(`qhooks: ${QHOOKS_URL} (http)`), text);
    check("gemini: the QHooks referral note is in GEMINI.md (no skill system)", readIf(join(home, ".gemini/GEMINI.md")).includes(QHOOKS_REFERRER));
    check("gemini: instructions arrived", readIf(join(home, ".gemini/GEMINI.md")).includes(MARKER));
  }

  // OpenClaw
  {
    const v = run(bin("openclaw"), ["config", "validate"]);
    check("openclaw accepts its config", v.code === 0, v.out + v.err);
    const r = run(bin("openclaw"), ["mcp", "list", "--json"]);
    const by = json(r.out) ?? {};
    check("openclaw lists the servers", r.code === 0 && typeof by === "object", r.out + r.err);
    check("openclaw: github runs npx", by.github?.command === "npx", JSON.stringify(by.github));
    check("openclaw: docs points at its URL", by.docs?.url === "https://mcp.example.com/mcp", JSON.stringify(by.docs));
    check("openclaw: notes keeps its arguments", by.notes?.command === "node" && JSON.stringify(by.notes?.args) === JSON.stringify(["/opt/notes/server.js", "--readonly"]), JSON.stringify(by.notes));
    check("openclaw: HEY's hosted research profile", by["hey-research"]?.url === "https://heyresearch.xyz/mcp/research", JSON.stringify(by["hey-research"]));
    // Newer OpenClaw hides every setting value when it lists servers, so the value is read from its file.
    let file = {};
    try {
      file = JSON.parse(readIf(join(home, ".openclaw/openclaw.json")));
    } catch {
      /* checked below */
    }
    const listed = by["hey-local"]?.env?.HEY_MCP_PROFILE;
    check("openclaw: HEY's local server keeps its pin and profile", JSON.stringify(by["hey-local"]?.args) === JSON.stringify(["-y", "@hey-research-lab/mcp@0.3.5"]) && (listed === "research" || listed === "__OPENCLAW_REDACTED__") && file?.mcp?.servers?.["hey-local"]?.env?.HEY_MCP_PROFILE === "research", JSON.stringify(by["hey-local"]));
    check("openclaw: QHooks with Nomad's referral", by.qhooks?.url === QHOOKS_URL && file?.mcp?.servers?.qhooks?.url === QHOOKS_URL, JSON.stringify(by.qhooks));
    check("openclaw: the qhooks-referral skill", readIf(join(home, ".openclaw/workspace/skills/qhooks-referral/SKILL.md")).includes(QHOOKS_REFERRER));
    check("openclaw: instructions arrived", readIf(join(home, ".openclaw/workspace/AGENTS.md")).includes(MARKER));
  }

  // No secret value was written anywhere outside the source files.
  const source = new Set([join(home, ".claude.json"), join(home, ".claude/CLAUDE.md")]);
  const leaked = filesBelow(home).filter((p) => !source.has(p) && !p.startsWith(join(home, ".nomad")) && /\.(json|toml|ya?ml|md|env)$/.test(p) && [GITHUB_TOKEN, API_KEY].some((s) => readIf(p).includes(s)));
  check("no secret value was written to any app", leaked.length === 0, leaked.join("\n"));
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll real-app checks passed.");
process.exit(failed ? 1 : 0);
