/** Bounties wired to this deployment: Redis, Robinhood Chain reads, Venin and the secret scan. */
import { decodeEventLog, getAddress, parseAbi, type Address, type Hex } from "viem";
import { scanText } from "@nomad/security";
import { NOMAD, TREASURY, USDG } from "../accounts/chain";
import { BOUNTIES, REVIEWERS, SPONSORS } from "../bounties/list";
import type { PrizeToken } from "../bounties/shared";
import { redisFromEnv } from "../redis";
import { agentStore } from "./agents-store";
import { mainAccountOf, serverClient } from "./agent-exec";
import { bounties, bountyStore, parseSponsors } from "./bounties";
import { CLAIMED } from "./credits";
import { veninCheck } from "./venin-check";
import { parseMcpAnswer } from "./mcp";
import { BULL_MCP, createdAgreement } from "../bounties/bull";
import { madeBy, type StoaService } from "../bounties/proof";
import { repoChecker } from "./repo-check";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
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
    sponsors: [...parseSponsors(JSON.stringify(SPONSORS)), ...parseSponsors(process.env.BOUNTY_SPONSORS).filter((x) => !SPONSORS.some((y) => y.account.toLowerCase() === x.account.toLowerCase()))],
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
      return madeBy(r, wallet);
    },
    async paid(token, to, amount, tx, from = TREASURY) {
      const r = await client.getTransactionReceipt({ hash: tx as Hex });
      if (r.status !== "success") return false;
      let sent = 0n;
      for (const l of r.logs) {
        if (lc(l.address) !== lc(TOKEN[token])) continue;
        try {
          const ev = decodeEventLog({ abi: TRANSFER, data: l.data, topics: l.topics });
          if (lc(ev.args.from) === lc(from) && lc(ev.args.to) === lc(to)) sent += ev.args.value;
        } catch {
          /* another event */
        }
      }
      return sent >= amount;
    },
    // A deposit joins the set credits use, so the same transfer can never also be claimed as credits.
    claimTx: async (tx) => Number(await redis.cmd(["SADD", CLAIMED, tx.toLowerCase()])) === 1,
    async escrowCreated(tx) {
      const r = await client.getTransactionReceipt({ hash: tx });
      return r.status === "success" ? createdAgreement(r.logs) : null;
    },
    async bullPlan(args) {
      const r = await fetch(BULL_MCP, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bull_agreement_from_template", arguments: args } }),
        signal: AbortSignal.timeout(20_000),
        cache: "no-store"
      });
      const j = parseMcpAnswer(await r.text());
      const res = j.result as { structuredContent?: unknown; isError?: boolean; content?: { text?: string }[] } | undefined;
      if (!res || res.isError) throw new Error(j.error?.message ?? "Bull did not answer.");
      const plan = (res.structuredContent ?? JSON.parse(res.content?.[0]?.text ?? "null")) as Record<string, unknown> | null;
      const err = plan?.error as { message?: string } | undefined;
      if (!plan || err) throw new Error(err?.message ?? "Bull gave no plan.");
      return plan;
    },
    repoCheck: repoChecker({
      token: process.env.GITHUB_TOKEN?.trim() || undefined,
      cache: { get: (k) => agents.cacheGet<string>(k), set: (k, v, sec) => agents.cacheSet(k, v, sec) }
    }),
    async receiptOf(tx) {
      const r = await client.getTransactionReceipt({ hash: tx }).catch((e: Error) => (/not be found|not found/i.test(e.message) ? null : Promise.reject(e)));
      if (!r) return null;
      const block = await client.getBlock({ blockNumber: r.blockNumber });
      return { status: r.status, from: r.from, logs: r.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics as Hex[] })), time: Number(block.timestamp) * 1000 };
    },
    async stoaServices() {
      const hit = await agents.cacheGet<StoaService[]>("stoa-services");
      if (hit) return hit;
      const r = await fetch("https://stoadex.com/api/v1/services", { signal: AbortSignal.timeout(15_000), cache: "no-store" });
      if (!r.ok) throw new Error(`Stoa answered ${r.status}`);
      const j = (await r.json()) as { services?: { id?: unknown; name?: unknown; wallet?: unknown; price?: unknown; active?: unknown }[] };
      const list: StoaService[] = [];
      for (const x of j.services ?? []) {
        if (x.active === false || typeof x.wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(x.wallet) || !/^\d+(\.\d{1,6})?$/.test(String(x.price ?? ""))) continue;
        list.push({ id: String(x.id ?? ""), name: String(x.name ?? "A Stoa service").slice(0, 80), wallet: getAddress(x.wallet), price: String(x.price) });
      }
      await agents.cacheSet("stoa-services", list, 600);
      return list;
    },
    venin: async (path, text) => (await veninCheck(path, text)).planted,
    secrets: (text) => scanText(text, "submission.md").length
  });
}
