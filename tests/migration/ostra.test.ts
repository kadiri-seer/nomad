import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { applyKnownServerProfile, knownServerId } from "@nomad/adapters";
import { isKeyMaterialPath } from "@nomad/core/node";
import { isSecretEnvEntry, redactText, scanText } from "@nomad/security";
import type { Tool } from "@nomad/schema";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_BACKUP, FAKE_OSTRA_SECRETS, FAKE_RPC_WITH_KEY, OSTRA_CONNECTOR, buildClaudeCodeOstra } from "../fixtures/ostra";

/**
 * Ostra setups (a post-quantum vault for AI agents on Robinhood Chain) moving between platforms. The seed
 * folder is never read; a seed comes back on another computer only through Ostra's own encrypted backup.
 */

let env: Env;
let src: string;
beforeEach(() => {
  env = setup();
  src = join(env.home, "ostra");
  mkdirSync(src, { recursive: true });
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
  for (const t of texts) for (const s of FAKE_OSTRA_SECRETS) expect(t.includes(s), "a seed, backup or RPC key leaked").toBe(false);
}

const notes = (plan: { notes: Array<{ message: string }> }) => plan.notes.map((n) => n.message).join("\n");
const warnings = (plan: { notes: Array<{ level: string; message: string }> }) => plan.notes.filter((n) => n.level === "warning").map((n) => n.message).join("\n");
const steps = (plan: { manualSteps: string[] }) => plan.manualSteps.join("\n");

describe("Ostra setups", () => {
  it("Claude Code to Codex: the server and connector arrive, the keyed RPC is a reference, off stays off, the seed stays", async () => {
    const cc = buildClaudeCodeOstra(src);
    const before = treeHash(src);
    const dest = emptyDir(env.home, "c2x/.codex");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "codex", root: dest });
    const cfg = parseToml(read(join(dest, "config.toml"))) as any;
    const local = cfg.mcp_servers.ostra;
    expect(local.command).toBe("npx");
    expect(local.args).toEqual(["-y", "@ostraagent/mcp@0.1.24"]);
    expect(local.env).toEqual({ OSTRA_ETH_RPC_URL: "off", OSTRA_LOGS_RPC_URL: "https://rpc.mainnet.chain.robinhood.com", OSTRA_AI_URL: "off" });
    expect(local.env_vars).toEqual(["OSTRA_RPC_URL"]);
    expect(cfg.mcp_servers["ostra-connector"]).toEqual({ url: OSTRA_CONNECTOR });
    expect(notes(plan)).toContain(`"ostra" runs Ostra's vault server on this computer. Its seed (master.key in ~/.ostra) holds every vault of the agent; Nomad never reads, copies or moves it.`);
    expect(warnings(plan)).toContain(`Ostra runs one seed in one place at a time. Before "ostra" starts on Codex, remove Ostra from the app you moved it from, or turn it off there.`);
    expect(steps(plan)).toContain(`If Codex runs on another computer, "ostra" needs the same seed there, or it starts a new, empty vault. Stop Ostra on this computer and run npx -y @ostraagent/mcp backup export <file> here; then, on the new computer, run npx -y @ostraagent/mcp backup import <file> before Codex first starts it.`);
    expect(steps(plan)).toContain(`"ostra" runs Ostra's server through npx: Codex needs Node.js 22 or later`);
    expect(notes(plan)).toContain(`"ostra-connector" is Ostra's hosted connector. Nomad copies its address.`);
    expect(steps(plan)).toContain(`Sign in to "ostra-connector" again on Codex`);
    expectNoLeak(allText(dest), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome));
    expect(treeHash(src)).toBe(before);
  });

  it("Claude Code to OpenClaw with --include-secrets: the keyed RPC is copied as asked, but the seed and backup never are", async () => {
    const cc = buildClaudeCodeOstra(src);
    const oc = emptyDir(env.home, "c2o/.openclaw");
    const { plan, receipt } = await migrate({ adapter: "claude-code", root: cc, nativeId: "main" }, { adapter: "openclaw", root: oc }, { includeSecrets: true });
    const servers = (JSON5.parse(read(join(oc, "openclaw.json"))) as any).mcp.servers;
    expect(servers.ostra.env.OSTRA_ETH_RPC_URL).toBe("off");
    expect(servers.ostra.env.OSTRA_RPC_URL).toBe(FAKE_RPC_WITH_KEY);
    expect(servers["ostra-connector"]).toEqual({ url: OSTRA_CONNECTOR, transport: "streamable-http" });
    // The seed folder and the backup were never read, so nothing of them can be in anything Nomad wrote.
    for (const t of [allText(oc), JSON.stringify(plan), JSON.stringify(receipt), allText(env.nomadHome)]) {
      expect(t.includes("5f".repeat(32))).toBe(false);
      expect(t.includes(JSON.parse(FAKE_BACKUP).ciphertext)).toBe(false);
    }
  });

  it("an Ostra backup pasted into notes is removed; the seed folder and backup files are key material", async () => {
    const folder = join(src, "agent");
    mkdirSync(join(folder, "memory"), { recursive: true });
    writeFileSync(join(folder, "SOUL.md"), "You are a careful payer.\n");
    writeFileSync(join(folder, "memory/notes.md"), `- Seed backup, keep safe: ${FAKE_BACKUP}\n- Balance checked.\n`);
    const oc = emptyDir(env.home, "f2o/.openclaw");
    const { plan } = await migrate({ adapter: "generic", root: folder, nativeId: "folder" }, { adapter: "openclaw", root: oc });
    const memory = read(join(oc, "workspace/MEMORY.md"));
    expect(memory).toContain("Balance checked.");
    expect(memory).toContain("[REDACTED:ostra-seed-backup]");
    expectNoLeak(allText(oc), JSON.stringify(plan));
    for (const p of ["/home/a/.ostra/master.key", "/home/a/.ostra/wots/x.json", "C:\\Users\\a\\.ostra\\fee-payer.key", "/home/a/ostra-seed-backup.json", "/home/a/Backups/my-seed-backup-2026.json"]) expect(isKeyMaterialPath(p), p).toBe(true);
    for (const p of ["/home/a/ostra/notes.md", "/home/a/seed.json", "/home/a/backup.json"]) expect(isKeyMaterialPath(p), p).toBe(false);
  });

  it("another deployment, other service addresses, a prover and an RPC file each get their note or step", () => {
    const local = (envVars: Record<string, string>): Tool => ({ name: "o", kind: "mcp", mcp: { transport: "stdio", command: "ostra-mcp", args: [], env: Object.fromEntries(Object.entries(envVars).map(([k, v]) => [k, { value: v }])), headers: {} } }) as unknown as Tool;
    const all = (envVars: Record<string, string>) => {
      const r = applyKnownServerProfile(local(envVars), "Hermes");
      return [...r.notes.map((n) => `${n.level}: ${n.message}`), ...r.manualSteps].join("\n");
    };
    expect(all({ OSTRA_DEPLOYMENT: "/opt/ostra/fork.json" })).toContain(`warning: "o" uses another Ostra deployment record (OSTRA_DEPLOYMENT=/opt/ostra/fork.json): it decides which contracts the vault uses.`);
    expect(all({ OSTRA_RELAYER_URL: "https://relay.example.org" })).toContain(`warning: "o" uses https://relay.example.org (OSTRA_RELAYER_URL) instead of Ostra's https://relayer.ostraagent.xyz.`);
    expect(all({ OSTRA_RELAYER_URL: "off", OSTRA_AI_URL: "https://ai.ostraagent.xyz/" })).not.toContain("instead of Ostra's");
    expect(all({ OSTRA_PROVER: "/usr/local/bin/ostra-prove" })).toContain(`"o" proves with /usr/local/bin/ostra-prove (OSTRA_PROVER), a program Nomad does not copy.`);
    expect(all({ OSTRA_RPC_URL_FILE: "/home/a/.config/ostra-rpc" })).toContain(`reads its RPC address from /home/a/.config/ostra-rpc (OSTRA_RPC_URL_FILE), a file Nomad does not copy.`);
    expect(all({ OSTRA_HOME: "/srv/agents/payer" })).toContain("OSTRA_HOME=/srv/agents/payer npx -y @ostraagent/mcp backup export <file>");
    expect(all({ OSTRA_HOME: "/srv/agents/payer" })).toContain("master.key in /srv/agents/payer");
    expect(all({})).toContain("npm install -g @ostraagent/mcp. It needs Node.js 22 or later");
  });

  it("RPC settings: a keyed URL is a secret, off and public endpoints are values", () => {
    expect(isSecretEnvEntry("OSTRA_RPC_URL", "https://robinhood-mainnet.g.alchemy.com/v2/abc")).toBe(true);
    expect(isSecretEnvEntry("OSTRA_ETH_RPC_URL", "off")).toBe(false);
    expect(isSecretEnvEntry("OSTRA_ETH_RPC_URL", "https://ethereum-rpc.publicnode.com")).toBe(false);
    expect(isSecretEnvEntry("OSTRA_LOGS_RPC_URL", "https://rpc.mainnet.chain.robinhood.com")).toBe(false);
  });
});

describe("Ostra recognition", () => {
  const remote = (url: string): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "http", url, args: [], env: {}, headers: {} } }) as unknown as Tool;
  const local = (command: string, args: string[] = []): Tool => ({ name: "x", kind: "mcp", mcp: { transport: "stdio", command, args, env: {}, headers: {} } }) as unknown as Tool;

  it("recognises Ostra's package, command and connector", () => {
    for (const t of [
      local("npx", ["-y", "@ostraagent/mcp"]),
      local("npx", ["-y", "@ostraagent/mcp@0.1.24"]),
      local("ostra-mcp"),
      local("C:\\Users\\a\\AppData\\Roaming\\npm\\ostra-mcp.cmd"),
      remote(OSTRA_CONNECTOR),
      remote("https://mcp.ostraagent.xyz/mcp/")
    ]) {
      expect(knownServerId(t), JSON.stringify(t.mcp)).toBe("ostra");
    }
  });

  it("ignores look-alikes", () => {
    for (const t of [
      local("npx", ["-y", "@ostraagent/mcp-evil"]),
      local("npx", ["-y", "@evil/ostraagent-mcp"]),
      local("npx", ["-y", "ostra-mcp"]),
      local("ostra-mcp-evil"),
      remote("http://mcp.ostraagent.xyz/mcp"),
      remote("https://mcp.ostraagent.xyz.evil.example/mcp"),
      remote("https://evil.example/mcp.ostraagent.xyz/mcp"),
      remote("https://mcp.ostraagent.xyz:8443/mcp"),
      remote("https://app.ostraagent.xyz/mcp"),
      remote("https://mcp.ostraagent.xyz/other")
    ]) {
      expect(knownServerId(t), JSON.stringify(t.mcp)).toBeNull();
    }
  });

  it("finds an Ostra backup in text and removes only its ciphertext", () => {
    expect(scanText(FAKE_BACKUP, "t").map((f) => f.ruleId)).toContain("ostra-seed-backup");
    expect(redactText(FAKE_BACKUP).text).toContain('"ciphertext":"[REDACTED:ostra-seed-backup]"');
    expect(scanText('{"kdf":{"name":"pbkdf2"},"ciphertext":"' + "ab".repeat(20) + '"}', "t").map((f) => f.ruleId)).not.toContain("ostra-seed-backup");
  });

  it("the guide follows the same wording rules as the other setup guides", () => {
    const text = readFileSync(join(__dirname, "../../docs/guides/ostra-setups.md"), "utf8");
    for (const re of [/\bofficial\b/i, /\bpartner/i, /airdrop/i, /token launch/i, /supports ostra/i, /ostra integration/i, /—/]) expect(re.test(text), String(re)).toBe(false);
    expect(/(?<!Robin)Hood Chain/.test(text)).toBe(false);
  });
});
