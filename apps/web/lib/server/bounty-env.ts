/** Bounties wired to this deployment: Redis, Robinhood Chain reads, Venin and the secret scan. */
import { decodeEventLog, getAddress, parseAbi, type Address, type Hex } from "viem";
import { scanText } from "@nomad/security";
import { NOMAD, TREASURY, USDG } from "../accounts/chain";
import { BOUNTIES, REVIEWERS } from "../bounties/list";
import type { PrizeToken } from "../bounties/shared";
import { redisFromEnv } from "../redis";
import { agentStore } from "./agents-store";
import { mainAccountOf, serverClient } from "./agent-exec";
import { bounties, bountyStore } from "./bounties";
import { veninCheck } from "./venin-check";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const USEROP = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
const ENTRY_POINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const TOKEN: Record<PrizeToken, Address> = { USDG, NOMAD };
const lc = (a: string) => a.toLowerCase();

export function bountyEnv() {
  const redis = redisFromEnv();
  if (!redis) return null;
  const agents = agentStore(redis);
  const client = serverClient();
  return bounties({
    store: bountyStore(redis),
    list: BOUNTIES,
    reviewers: REVIEWERS,
    now: () => Date.now(),
    async treasuryBalance(token) {
      const key = `treasury-balance:${token}`;
      const hit = await agents.cacheGet<string>(key);
      if (hit) return BigInt(hit);
      const v = await client.readContract({ address: TOKEN[token], abi: ERC20, functionName: "balanceOf", args: [TREASURY] });
      await agents.cacheSet(key, v.toString(), 120);
      return v;
    },
    verify: (address, message, signature) => client.verifyMessage({ address, message, signature }),
    mainAccountOf: async (signer) => getAddress(await mainAccountOf(signer)),
    agent: (id) => agents.get(id),
    async txBy(wallet, tx, sinceMs) {
      const r = await client.getTransactionReceipt({ hash: tx });
      if (r.status !== "success") return false;
      const block = await client.getBlock({ blockNumber: r.blockNumber });
      if (Number(block.timestamp) * 1000 < sinceMs) return false;
      if (lc(r.from) === lc(wallet)) return true;
      // A smart account's transaction is sent by a bundler: its own operation in the receipt says who it was.
      return r.logs.some((l) => {
        if (lc(l.address) !== ENTRY_POINT) return false;
        try {
          const ev = decodeEventLog({ abi: USEROP, data: l.data, topics: l.topics });
          return lc(ev.args.sender) === lc(wallet) && ev.args.success;
        } catch {
          return false;
        }
      });
    },
    async paid(token, to, amount, tx) {
      const r = await client.getTransactionReceipt({ hash: tx as Hex });
      if (r.status !== "success") return false;
      let sent = 0n;
      for (const l of r.logs) {
        if (lc(l.address) !== lc(TOKEN[token])) continue;
        try {
          const ev = decodeEventLog({ abi: TRANSFER, data: l.data, topics: l.topics });
          if (lc(ev.args.from) === lc(TREASURY) && lc(ev.args.to) === lc(to)) sent += ev.args.value;
        } catch {
          /* another event */
        }
      }
      return sent >= amount;
    },
    venin: async (path, text) => (await veninCheck(path, text)).planted,
    secrets: (text) => scanText(text, "submission.md").length
  });
}
