/**
 * Shared setup for the account routes (paymaster, credits, bundler): what is configured on this deployment, and
 * errors as JSON. Secrets live only in the deployment's environment:
 *   NOMAD_PAYMASTER_SIGNER_KEY   the key NomadPaymaster trusts (0x + 64 hex), never sent anywhere
 *   ALCHEMY_RPC_URL              Alchemy's Robinhood Chain endpoint with its key, used only server-side
 *   NEXT_PUBLIC_NOMAD_PAYMASTER  the deployed NomadPaymaster's address
 */
import { NextResponse } from "next/server";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { redisFromEnv, type RedisLike } from "../vote/redis";
import { AGENTS_CONTRACT } from "../economy";
import { CHAIN_ID, NOMAD, PAYMASTER, PUBLIC_RPC, TREASURY, USDG } from "../accounts/chain";
import { hold, useFreeOpFor, type CreditsDeps } from "./credits";
import { stoa } from "./stoa";
import { agentStore } from "./agents-store";
import type { SponsorDeps } from "./sponsor";

const NO_STORE = { "cache-control": "no-store" };
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const chain = { id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [PUBLIC_RPC] } } } as const;
const publicClient = () => createPublicClient({ chain, transport: http(PUBLIC_RPC, { timeout: 15_000 }) });

let gasCache: { at: number; wei: bigint } | null = null;
/** The chain's gas price, read at most every 30 seconds. */
async function gasPrice(): Promise<bigint | null> {
  if (gasCache && Date.now() - gasCache.at < 30_000) return gasCache.wei;
  try {
    const wei = await publicClient().getGasPrice();
    gasCache = { at: Date.now(), wei };
    return wei;
  } catch {
    return gasCache?.wei ?? null;
  }
}

let priceCache: { at: number; usd: number } | null = null;
/** ETH's price in dollars: Robinhood Chain's explorer, then Coinbase; cached for five minutes. */
export async function ethUsd(): Promise<number> {
  if (priceCache && Date.now() - priceCache.at < 300_000) return priceCache.usd;
  const tries: [string, (j: any) => unknown][] = [
    ["https://robinhoodchain.blockscout.com/api/v2/stats", (j) => j?.coin_price],
    ["https://api.coinbase.com/v2/prices/ETH-USD/spot", (j) => j?.data?.amount]
  ];
  for (const [url, pick] of tries) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
      const v = Number(pick(await r.json()));
      if (v > 100 && v < 100_000) {
        priceCache = { at: Date.now(), usd: v };
        return v;
      }
    } catch {
      /* next source */
    }
  }
  if (priceCache) return priceCache.usd;
  throw new Error("No ETH price");
}

/** Calls Alchemy's bundler on Robinhood Chain (the key stays on the server). */
export async function bundlerCall(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const url = process.env.ALCHEMY_RPC_URL?.trim();
  if (!url) throw new Error("ALCHEMY_RPC_URL is not set");
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000), cache: "no-store" });
  const text = await r.text();
  try {
    return JSON.parse(text) as { result?: unknown; error?: { code: number; message: string } };
  } catch {
    // Never echo the URL (it holds the API key); the status and the start of the answer are enough to see what failed.
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 120).replace(url, "[endpoint]")}`);
  }
}

export function creditsDeps(redis: RedisLike): CreditsDeps {
  return {
    redis,
    ethUsd,
    txReceipt: async (hash: Hex) => {
      try {
        const rc = await publicClient().getTransactionReceipt({ hash });
        return { status: rc.status, logs: rc.logs };
      } catch {
        return null;
      }
    },
    nomadValueMicros: async (amount: bigint) => (await stoa().quote(NOMAD, USDG, amount, TREASURY)).amountOut,
    userOpCost: async (hash: Hex) => {
      const r = await bundlerCall("eth_getUserOperationReceipt", [hash]);
      const res = r.result as { actualGasCost?: string } | null | undefined;
      return res?.actualGasCost ? BigInt(res.actualGasCost) : null;
    }
  };
}

/**
 * The paymaster service's dependencies, or why it is not available on this deployment. `user` is the Privy id of
 * the signed-in person making the request: free operations go only to them, never to the server's own calls.
 */
export function sponsorDeps(user: string | null = null): { sponsor: SponsorDeps; credits: CreditsDeps } | string {
  if (!PAYMASTER) return "Gas is not set up on this site yet.";
  const key = process.env.NOMAD_PAYMASTER_SIGNER_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return "Gas is not set up on this site yet.";
  if (!process.env.ALCHEMY_RPC_URL?.trim()) return "Gas is not set up on this site yet.";
  const redis = redisFromEnv();
  if (!redis) return "Storage is not connected on this site.";
  const credits = creditsDeps(redis);
  return {
    credits,
    sponsor: {
      paymaster: PAYMASTER as Address,
      agents: (AGENTS_CONTRACT ?? "") as Address | "",
      signer: privateKeyToAccount(key as Hex),
      useFreeOp: (account, day) => useFreeOpFor(redis, { account, user }, day),
      gasPrice,
      hold: (account, wei, hash, until) => hold(credits, account, wei, hash, until),
      agentByAccount: (account) => agentStore(redis).byAccount(account)
    }
  };
}

/** A small per-address limit on the public account routes, so nobody can run through the bundler's quota. */
export async function rateLimited(req: Request, route: string, perMinute: number): Promise<boolean> {
  const redis = redisFromEnv();
  if (!redis) return false;
  const ip = (req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown").trim().slice(0, 64);
  const key = `nomad:rl:${route}:${ip}:${Math.floor(Date.now() / 60_000)}`;
  try {
    const n = Number(await redis.cmd(["INCR", key]));
    if (n === 1) await redis.cmd(["EXPIRE", key, 120]);
    return n > perMinute;
  } catch {
    return false;
  }
}
