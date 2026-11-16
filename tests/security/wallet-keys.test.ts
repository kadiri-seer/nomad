import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createDocument, fromUtf8 } from "@nomad/core";
import { isWalletEnvEntry, sanitizeDocument } from "@nomad/security";
import { createZip, packAgent, unpackAgent, writeNomadPack } from "@nomad/archive";
import { emptyDir, read, setup, treeHash, type Env } from "../helpers";
import { FAKE_GITHUB_TOKEN, FAKE_OPENAI_KEY } from "../fixtures/platforms";

/**
 * Wallet private keys and recovery phrases never travel as values, even with --include-secrets:
 * a leaked API key can be revoked, a leaked wallet key cannot. Other secrets still travel when asked.
 */

const WALLET_KEY = "0x" + "9e8d7c6b5a493827".repeat(4);
const BARE_WALLET_KEY = "1a2b3c4d5e6f7a8b".repeat(4);
const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const SOLANA_KEY = "A1b2C3d4".repeat(11);
const SOLANA_BYTES = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7) % 256));
const TX_HASH = "0x" + "ab12cd34ef56ab78".repeat(4);
const WALLET_SECRETS = [WALLET_KEY, WALLET_KEY.slice(2), BARE_WALLET_KEY, MNEMONIC, SOLANA_KEY, SOLANA_BYTES];

const v = (value: string) => ({ value });

function walletDoc() {
  const d = createDocument({ name: "Wallet agent", platform: "generic" });
  d.instructions.push({ id: "main", kind: "agent", content: `Sign with my wallet private key ${WALLET_KEY}. Use ${FAKE_GITHUB_TOKEN} for GitHub. The deploy tx was ${TX_HASH}.` });
  d.memory.push({ id: "m1", kind: "fact", scope: "agent", content: `Backup phrase: ${MNEMONIC}`, tags: [] });
  d.tools.push({
    name: "chain",
    kind: "mcp",
    enabled: true,
    mcp: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "chain-mcp", "--signer", WALLET_KEY, "--api-key", FAKE_OPENAI_KEY],
      env: {
        PRIVATE_KEY: v(WALLET_KEY),
        AGENT_PRIVATE_KEY: v(BARE_WALLET_KEY),
        WALLET_MNEMONIC: v(MNEMONIC),
        SOLANA_PRIVATE_KEY: v(SOLANA_KEY),
        SOLANA_WALLET_BYTES: v(SOLANA_BYTES),
        OPENAI_API_KEY: v(FAKE_OPENAI_KEY),
        RPC_URL: v("https://rpc.example-provider.io/v2/abcdef123456"),
        CHAIN_ID: v("4663")
      },
      headers: {}
    }
  } as never);
  d.tools.push({
    name: "remote",
    kind: "mcp",
    enabled: true,
    mcp: { transport: "http", url: "https://mcp.example.io/mcp", args: [], env: {}, headers: { Authorization: v(`Bearer ${FAKE_GITHUB_TOKEN}`), "X-Signer": v(WALLET_KEY) } }
  } as never);
  d.files.push({ path: ".env", encoding: "utf8", content: `PRIVATE_KEY=${WALLET_KEY}\nOPENAI_API_KEY=${FAKE_OPENAI_KEY}\n` } as never);
  return d;
}

const noWallet = (...texts: string[]) => {
  for (const t of texts) for (const s of WALLET_SECRETS) expect(t.includes(s), `wallet material leaked: ${s.slice(0, 12)}…`).toBe(false);
};

describe("wallet keys with --include-secrets", () => {
  it("recognises wallet key material and leaves other secrets alone", () => {
    expect(isWalletEnvEntry("PRIVATE_KEY", WALLET_KEY)).toBe(true);
    expect(isWalletEnvEntry("ANYTHING", WALLET_KEY)).toBe(true);
    expect(isWalletEnvEntry("AGENT_PRIVATE_KEY", BARE_WALLET_KEY)).toBe(true);
    expect(isWalletEnvEntry("HEDGEHOOD_SESSION_KEY", BARE_WALLET_KEY)).toBe(true);
    expect(isWalletEnvEntry("SEED", MNEMONIC)).toBe(true);
    expect(isWalletEnvEntry("NOTES", MNEMONIC)).toBe(true);
    expect(isWalletEnvEntry("SOLANA_PRIVATE_KEY", SOLANA_KEY)).toBe(true);
    expect(isWalletEnvEntry("SOLANA_WALLET_BYTES", SOLANA_BYTES)).toBe(true);
    expect(isWalletEnvEntry("OPENAI_API_KEY", FAKE_OPENAI_KEY)).toBe(false);
    expect(isWalletEnvEntry("GITHUB_TOKEN", FAKE_GITHUB_TOKEN)).toBe(false);
    // A 64-character hex value under an API name is an API key, not a wallet key.
    expect(isWalletEnvEntry("SERVICE_API_KEY", BARE_WALLET_KEY)).toBe(false);
    expect(isWalletEnvEntry("CHAIN_ID", "4663")).toBe(false);
  });

  it("a raw key under another name ending in KEY is a wallet key; service keys are not", () => {
    for (const k of ["AGENT_KEY", "BOT_KEY", "KEY", "TRADER_KEY"]) {
      expect(isWalletEnvEntry(k, BARE_WALLET_KEY), k).toBe(true);
      expect(isWalletEnvEntry(k, SOLANA_KEY), k).toBe(true);
    }
    for (const k of ["SERVICE_API_KEY", "OPENAI_API_KEY", "ACCESS_KEY", "AUTH_KEY", "TOKEN_KEY", "CLIENT_KEY", "LICENSE_KEY", "PUBLIC_KEY", "PUBKEY"]) expect(isWalletEnvEntry(k, BARE_WALLET_KEY), k).toBe(false);
    // Values that are not wallet-shaped stay as they are under any name.
    expect(isWalletEnvEntry("AGENT_KEY", "short")).toBe(false);
    expect(isWalletEnvEntry("AGENT_KEY", "~/.config/agent.key")).toBe(false);
  });

  it("the sanitizer keeps other secrets but removes wallet keys everywhere", () => {
    const { doc, report } = sanitizeDocument(walletDoc(), { includeSecrets: true, includeSensitiveFiles: true });
    const all = JSON.stringify(doc);
    noWallet(all);
    const chain = doc.tools.find((t) => t.name === "chain")!.mcp!;
    for (const k of ["PRIVATE_KEY", "AGENT_PRIVATE_KEY", "WALLET_MNEMONIC", "SOLANA_PRIVATE_KEY", "SOLANA_WALLET_BYTES"]) expect(chain.env[k]).toEqual({ secretRef: k, redacted: true });
    expect(chain.env.OPENAI_API_KEY).toEqual({ value: FAKE_OPENAI_KEY });
    expect(chain.env.RPC_URL).toEqual({ value: "https://rpc.example-provider.io/v2/abcdef123456" });
    expect(chain.env.CHAIN_ID).toEqual({ value: "4663" });
    expect(chain.args).toEqual(["-y", "chain-mcp", "--signer", "[REDACTED:evm-private-key]", "--api-key", FAKE_OPENAI_KEY]);
    const remote = doc.tools.find((t) => t.name === "remote")!.mcp!;
    expect(remote.headers.Authorization).toEqual({ value: `Bearer ${FAKE_GITHUB_TOKEN}` });
    expect(remote.headers["X-Signer"]).toEqual({ secretRef: "X-Signer", redacted: true });
    expect(doc.instructions[0].content).toContain(FAKE_GITHUB_TOKEN);
    // A transaction hash without key words around it is not a key.
    expect(doc.instructions[0].content).toContain(TX_HASH);
    expect(doc.memory[0].content).toBe("Backup phrase: [REDACTED:bip39-mnemonic]");
    const env = doc.files.find((f) => f.path === ".env")!;
    expect(env.content).toContain(FAKE_OPENAI_KEY);
    expect(env.content).toContain("PRIVATE_KEY=[REDACTED:evm-private-key]");
    expect(report.includedSecrets).toBe(true);
    // 5 env, 1 header, 1 argument, 1 instruction, 1 memory, 1 file.
    expect(report.walletKeysKept).toBe(10);
  });

  it("without --include-secrets nothing changes: every secret is left out", () => {
    const { doc, report } = sanitizeDocument(walletDoc());
    const all = JSON.stringify(doc);
    noWallet(all);
    expect(all.includes(FAKE_OPENAI_KEY)).toBe(false);
    expect(all.includes(FAKE_GITHUB_TOKEN)).toBe(false);
    expect(report.walletKeysKept).toBe(0);
  });

  it("a .nomad export with secrets carries API keys but no wallet key", () => {
    const p = packAgent(walletDoc(), { includeSecrets: true, includeSensitiveFiles: true });
    const bytes = Buffer.from(p.bytes).toString("latin1");
    const files = [...p.files.values()].map((b) => fromUtf8(b));
    noWallet(bytes, ...files);
    expect(files.some((f) => f.includes(FAKE_OPENAI_KEY))).toBe(true);
    expect(p.manifest.secrets!.included).toBe(true);
  });

  it("opening an older package that holds a wallet key drops it, even with secrets included", () => {
    const { files } = writeNomadPack(walletDoc());
    const u = unpackAgent(createZip(files), { includeSecrets: true });
    expect(u.ok).toBe(true);
    noWallet(JSON.stringify(u.doc));
    expect(JSON.stringify(u.doc)).toContain(FAKE_OPENAI_KEY);
    expect(u.sanitize!.walletKeysKept).toBeGreaterThan(0);
  });
});

describe("moving a Codex agent with a wallet key, with --include-secrets", () => {
  let env: Env;
  beforeEach(() => (env = setup()));
  afterEach(() => env.cleanup());

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

  function buildCodex(home: string) {
    const r = join(home, ".codex");
    const put = (p: string, s: string) => {
      mkdirSync(dirname(join(r, p)), { recursive: true });
      writeFileSync(join(r, p), s);
    };
    put("AGENTS.md", `# Rules\n\n- Sign with the wallet private key ${WALLET_KEY}.\n- Recovery: ${MNEMONIC}\n`);
    put("config.toml", `model = "gpt-5-codex"

[mcp_servers.chain]
command = "npx"
args = ["-y", "chain-mcp", "--signer", "${WALLET_KEY}"]

[mcp_servers.chain.env]
PRIVATE_KEY = "${WALLET_KEY}"
AGENT_PRIVATE_KEY = "${BARE_WALLET_KEY}"
OPENAI_API_KEY = "${FAKE_OPENAI_KEY}"
CHAIN_ID = "4663"
`);
    return r;
  }

  it("writes the API key, leaves every wallet key out, says so, and leaves the source unchanged", async () => {
    const home = join(env.home, "src");
    mkdirSync(home, { recursive: true });
    const root = buildCodex(home);
    const hash = treeHash(home);
    for (const [to, dest] of [
      ["claude-code", emptyDir(env.home, "to-cc/.claude")],
      ["hermes", emptyDir(env.home, "to-hermes/.hermes")],
      ["cursor", emptyDir(env.home, "to-cursor/.cursor")]
    ] as const) {
      const plan = await env.nomad.plan({ source: { kind: "location", adapter: "codex", root, nativeId: "main" }, destination: { adapter: to, root: dest }, includeSecrets: true });
      expect(plan.blocked).toEqual([]);
      expect(plan.notes.map((n) => n.message).join("\n")).toContain("wallet key(s) or recovery phrase(s) were left out although secrets are included");
      expect(plan.secrets.included).toBe(true);
      expect(plan.secrets.strippedEnv).toEqual(expect.arrayContaining(["chain:PRIVATE_KEY", "chain:AGENT_PRIVATE_KEY"]));
      expect(plan.secrets.strippedEnv).not.toContain("chain:OPENAI_API_KEY");
      const receipt = await env.nomad.execute(plan.id, { broaderPermissions: true });
      expect(receipt.status).toBe("success");
      const written = allText(dirname(dest));
      noWallet(JSON.stringify(plan), JSON.stringify(receipt), written);
      expect(written.includes(FAKE_OPENAI_KEY), `${to} got the API key that was asked for`).toBe(true);
    }
    noWallet(allText(join(env.nomadHome, "backups")));
    const exp = await env.nomad.exportAgent({ kind: "location", adapter: "codex", root, nativeId: "main" }, { outPath: join(env.home, "w.nomad"), includeSecrets: true });
    noWallet(Buffer.from(exp.bytes).toString("latin1"), ...[...exp.files.values()].map((b) => fromUtf8(b)));
    expect(read(join(root, "config.toml"))).toContain(WALLET_KEY);
    expect(treeHash(home)).toBe(hash);
  });
});
