#!/usr/bin/env node
// Checks Nomad's Upoch support with the real Codex and OpenClaw, in a throwaway home:
// 1. npm still publishes @upoch/guard with the upoch command the preview tells people to install.
//    Nothing from it is installed or run.
// 2. A Claude Code setup with `upoch mcp` and a planted (fake) ~/.upoch is moved to Codex and OpenClaw. Codex lists
//    the server as written, OpenClaw accepts its config, and nothing from ~/.upoch is in what Nomad wrote or keeps.
// Run after `pnpm build:cli`, with codex and openclaw on PATH or in NOMAD_APPS_BIN.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/nomad.js");
const bin = (name) => (process.env.NOMAD_APPS_BIN ? join(process.env.NOMAD_APPS_BIN, name) : name);
// Fake key material in Upoch's shape. It belongs to no wallet.
const FAKE_OWNER = "0x" + "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d";
const FAKE_ENCRYPTION = "9a3c" + "e1f07b6d2c58a4e19f3b7c0d6e2a5f81b4c9d7e3a6f0b2c8d5e1f4a7b0c3d6e9";
const home = mkdtempSync(join(tmpdir(), "nomad-upoch-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, NOMAD_FAKE_HOME: home, NOMAD_HOME: join(home, ".nomad"), CODEX_HOME: join(home, ".codex"), NO_COLOR: "1", CI: "1" };
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `\n     ${String(detail).trim().split("\n").join("\n     ")}` : ""}`);
  if (!ok) failed++;
};
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: home, env, encoding: "utf8", timeout: 180000, shell: process.platform === "win32" && cmd === "npm" });
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
const allText = (dir) => {
  if (!existsSync(dir)) return "";
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out.join("\n");
};

try {
  const view = run("npm", ["view", "@upoch/guard", "bin", "engines", "--json"]);
  const info = json(view.out) ?? {};
  check("npm publishes @upoch/guard with the upoch command", typeof info.bin?.upoch === "string", view.out + view.err);
  check("it needs Node.js 24 or later, as the preview says", String(info.engines?.node ?? "").includes("24"), JSON.stringify(info.engines));

  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".upoch"), { recursive: true });
  writeFileSync(join(home, ".upoch/secrets.json"), JSON.stringify({ ownerKey: FAKE_OWNER, encryptionKey: FAKE_ENCRYPTION }));
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# Rules\n\n- Checkpoint with Upoch before and after every trade.\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { upoch: { type: "stdio", command: "upoch", args: ["mcp"], env: {} } } }));
  for (const to of ["codex", "openclaw"]) {
    const m = run(process.execPath, [cli, "migrate", "--from", "claude-code", "--to", to, "-y"]);
    check(`nomad moved the setup to ${to}`, m.code === 0, m.out + m.err);
    check(`the preview for ${to} says to stop Upoch in the other app first`, (m.out + m.err).includes("Upoch does not coordinate two copies"), m.out + m.err);
  }
  const c = run(bin("codex"), ["mcp", "list", "--json"]);
  const cby = Object.fromEntries((json(c.out) ?? []).map((s) => [s.name, s]));
  check("codex lists the server as `upoch mcp`", cby.upoch?.transport?.command === "upoch" && JSON.stringify(cby.upoch.transport.args) === '["mcp"]', JSON.stringify(cby.upoch) + c.err);
  const v = run(bin("openclaw"), ["config", "validate"]);
  check("openclaw accepts its config", v.code === 0, v.out + v.err);
  const o = run(bin("openclaw"), ["mcp", "list", "--json"]);
  check("openclaw lists the server", (json(o.out) ?? {}).upoch?.command === "upoch", o.out + o.err);
  for (const dir of [".codex", ".openclaw", ".nomad"]) {
    const text = allText(join(home, dir));
    check(`nothing from ~/.upoch is in ${dir}`, !text.includes(FAKE_OWNER) && !text.includes(FAKE_ENCRYPTION));
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nUpoch checks passed.");
process.exit(failed ? 1 : 0);
