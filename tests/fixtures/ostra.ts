import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Ostra setups as Ostra documents them (@ostraagent/mcp 0.1.24 README, docs.ostraagent.xyz/keys and
 * /claude, read Nov 18, 2026): `claude mcp add ostra -- npx -y @ostraagent/mcp`, settings such as
 * OSTRA_RPC_URL (which can carry a provider key) and services turned "off", the seed in ~/.ostra, and the
 * hosted connector https://mcp.ostraagent.xyz/mcp. Every key, URL key and seed below is fake.
 */

function put(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export const OSTRA_CONNECTOR = "https://mcp.ostraagent.xyz/mcp";
export const FAKE_RPC_WITH_KEY = "https://robinhood-mainnet.g.alchemy.com/v2/" + "k9Qm2Vx7Lr4Tz8Kp1Ns6Wd3Hc5Jb0Fy";
export const FAKE_SEED = "5f".repeat(32);
/** Shaped like `backup export` output: {version, kdf: scrypt, salt, iv, ciphertext, tag}. */
export const FAKE_BACKUP_CIPHERTEXT = "a1b2c3d4e5f60718".repeat(4);
export const FAKE_BACKUP = JSON.stringify({ version: 1, kdf: { name: "scrypt", N: 131072, r: 8, p: 1 }, salt: "0f".repeat(16), iv: "1e".repeat(12), ciphertext: FAKE_BACKUP_CIPHERTEXT, tag: "2d".repeat(16) });
/** Must never appear in any plan, receipt, destination, backup or export. */
export const FAKE_OSTRA_SECRETS = [FAKE_RPC_WITH_KEY, FAKE_SEED, FAKE_BACKUP_CIPHERTEXT];

/**
 * Claude Code: the local server with a keyed RPC, the Ethereum RPC turned off and the public logs RPC, the
 * hosted connector, and Ostra's seed folder in the home folder, which Nomad must never touch.
 */
export function buildClaudeCodeOstra(home: string) {
  const r = join(home, ".claude");
  put(r, "CLAUDE.md", "# Preferences\n\n- Check the Ostra vault balance before paying for anything.\n");
  put(home, ".claude.json", JSON.stringify({
    mcpServers: {
      ostra: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@ostraagent/mcp@0.1.24"],
        env: { OSTRA_RPC_URL: FAKE_RPC_WITH_KEY, OSTRA_ETH_RPC_URL: "off", OSTRA_LOGS_RPC_URL: "https://rpc.mainnet.chain.robinhood.com", OSTRA_AI_URL: "off" }
      },
      "ostra-connector": { type: "http", url: OSTRA_CONNECTOR }
    }
  }, null, 2));
  put(home, ".ostra/master.key", FAKE_SEED);
  put(home, ".ostra/fee-payer.key", FAKE_SEED);
  put(home, "ostra-seed-backup.json", FAKE_BACKUP);
  return r;
}
