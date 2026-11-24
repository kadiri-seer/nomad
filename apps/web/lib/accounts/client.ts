/**
 * The account pages' side of Nomad accounts: the person's smart account (Modular Account V2, owned by the wallet
 * Privy keeps behind their Google sign-in), sending its operations through Nomad's bundler route with gas from
 * NomadPaymaster, balances, Stoa quotes and the calls for each action. Runs in the browser.
 */
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, http, parseUnits, toHex, type Address, type EIP1193Provider, type Hex } from "viem";
import { toAccount } from "viem/accounts";
import { createBundlerClient, createPaymasterClient } from "viem/account-abstraction";
import { toModularAccountV2 } from "@alchemy/smart-accounts";
import { AGENTS_ABI } from "../agents-contract";
import { CHAIN_ID, NOMAD, PUBLIC_RPC, STOA_QUOTE_API, TREASURY, USDG } from "./chain";

export const robinhood = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } }
} as const;

export const publicClient = createPublicClient({ chain: robinhood, transport: http(PUBLIC_RPC) });

export type Call = { to: Address; data: Hex; value?: bigint };

/** The person's wallet (Privy's embedded wallet) as a signer the smart account can use. */
export function ownerFromProvider(address: Address, provider: EIP1193Provider) {
  return toAccount({
    address,
    async signMessage({ message }) {
      const data = typeof message === "string" ? toHex(message) : typeof message.raw === "string" ? message.raw : toHex(message.raw);
      return (await provider.request({ method: "personal_sign", params: [data, address] })) as Hex;
    },
    async signTypedData(typedData) {
      return (await provider.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(typedData, (_, v) => (typeof v === "bigint" ? v.toString() : v))] })) as Hex;
    },
    async signTransaction() {
      throw new Error("Nomad accounts send user operations, not transactions.");
    }
  });
}

/** The smart account and a client that sends its operations, gas paid through Nomad's paymaster route. */
/**
 * `getToken` gives the signed-in person's Privy access token: the paymaster route needs it to grant the free
 * operations (account set-up, buying $NOMAD, credits, funding, withdrawing); without it everything is paid from credits.
 */
export async function accountClient(owner: ReturnType<typeof ownerFromProvider>, salt = 0n, getToken?: () => Promise<string | null>) {
  const account = await toModularAccountV2({ client: publicClient, owner, salt });
  const bundler = createBundlerClient({
    account,
    client: publicClient,
    chain: robinhood,
    transport: http("/api/account/bundler"),
    paymaster: createPaymasterClient({
      transport: http("/api/account/paymaster", {
        fetchFn: async (input, init) => {
          const headers = new Headers(init?.headers);
          const token = getToken ? await getToken().catch(() => null) : null;
          if (token) headers.set("authorization", `Bearer ${token}`);
          return fetch(input, { ...init, headers });
        }
      })
    }),
    userOperation: {
      async estimateFeesPerGas() {
        const block = await publicClient.getBlock();
        const base = block.baseFeePerGas ?? (await publicClient.getGasPrice());
        let priority = 0n;
        try {
          const r = await fetch("/api/account/bundler", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rundler_maxPriorityFeePerGas", params: [] }) });
          const j = (await r.json()) as { result?: Hex };
          if (j.result) priority = BigInt(j.result);
        } catch {
          /* Robinhood Chain ignores the tip */
        }
        return { maxFeePerGas: base * 2n + priority, maxPriorityFeePerGas: priority };
      }
    }
  });
  return { account, bundler, getToken };
}

/** Sends calls as one operation and waits for it on-chain. */
export async function send(client: Awaited<ReturnType<typeof accountClient>>, calls: Call[]): Promise<{ userOpHash: Hex; txHash: Hex }> {
  const userOpHash = await client.bundler.sendUserOperation({ calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })) });
  const receipt = await client.bundler.waitForUserOperationReceipt({ hash: userOpHash, timeout: 120_000 });
  if (!receipt.success) throw new Error("The transaction did not go through. Your funds did not move.");
  return { userOpHash, txHash: receipt.receipt.transactionHash };
}

export async function balances(address: Address) {
  const read = (token: Address) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] }).catch(() => 0n);
  const [nomad, usdg] = await Promise.all([read(NOMAD), read(USDG)]);
  return { nomad, usdg };
}

export const fmtNomad = (v: bigint) => Math.floor(Number(formatUnits(v, 18))).toLocaleString("en-US");
export const fmtUsdg = (v: bigint) => Number(formatUnits(v, 6)).toFixed(2);

type StoaQuote = { amountOut: string; minOut: string; priceImpactPct: number | null; tx?: { to: Address; data: Hex; value: string }; approval?: { token: Address; spender: Address; amount: string } };

/** Stoa's best route for a swap; with `to`, the ready calls (approval, then the swap) paying out to `to`. */
export async function stoaQuote(sellToken: Address, buyToken: Address, amount: bigint, to?: Address): Promise<{ amountOut: bigint; impactPct: number | null; calls: Call[] }> {
  const q = new URLSearchParams({ chain: "robinhood", sellToken, buyToken, amount: amount.toString(), slippageBps: "100" });
  if (to) q.set("taker", to);
  const r = await fetch(`${STOA_QUOTE_API}?${q}`, { cache: "no-store" });
  const j = (await r.json()) as StoaQuote & { error?: string };
  if (!r.ok || j.error) throw new Error(j.error ?? "No route for this swap right now.");
  const calls: Call[] = [];
  if (to && j.approval) calls.push({ to: j.approval.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [j.approval.spender, BigInt(j.approval.amount)] }) });
  if (to && j.tx) calls.push({ to: j.tx.to, data: j.tx.data, value: BigInt(j.tx.value) });
  return { amountOut: BigInt(j.amountOut), impactPct: j.priceImpactPct, calls };
}

/** $NOMAD for a dollar amount: Stoa's quote for selling that much USDG. */
export async function nomadForUsd(usd: number): Promise<bigint> {
  return (await stoaQuote(USDG, NOMAD, parseUnits(usd.toFixed(6), 6))).amountOut;
}

/** A credit top-up in USDG: a plain transfer to the treasury. */
export const topUpUsdgCalls = (amount: bigint): Call[] => [{ to: USDG, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [TREASURY, amount] }) }];

/** A credit top-up in $NOMAD: swapped by Stoa straight to the treasury in USDG. */
export const topUpNomadCalls = async (amount: bigint) => (await stoaQuote(NOMAD, USDG, amount, TREASURY)).calls;

/** Buying $NOMAD with USDG, paid out to the account itself. */
export const buyNomadCalls = async (usdg: bigint, account: Address) => stoaQuote(USDG, NOMAD, usdg, account);

/** The agent's package: what was chosen, hashed, so the minted agent is tied to exactly this set-up. */
export { agentPackage } from "../agents/shared";

/** Minting: approve exactly the fee, then mint (free copies by default; the creator can set a price later). */
export function mintCalls(agents: Address, fee: bigint, name: string, packageHash: Hex): Call[] {
  return [
    { to: NOMAD, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [agents, fee] }) },
    { to: agents, data: encodeFunctionData({ abi: AGENTS_ABI, functionName: "mint", args: [name, packageHash, "", 0n, fee] }) }
  ];
}

export async function mintFee(agents: Address): Promise<bigint> {
  return (await publicClient.readContract({ address: agents, abi: AGENTS_ABI, functionName: "mintFee" })) as bigint;
}

/** Sending money out of the account: a token transfer, or plain ETH when `token` is "eth". */
export function sendCalls(token: Address | "eth", to: Address, amount: bigint): Call[] {
  if (token === "eth") return [{ to, data: "0x", value: amount }];
  return [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) }];
}

/** Selling a token for USDG through Stoa, paid out to the account itself. */
export const sellCalls = async (token: Address, amount: bigint, account: Address) => stoaQuote(token, USDG, amount, account);

export type Holding = { token: Address | "eth"; symbol: string; decimals: number; amount: bigint };

const KNOWN = (a: Address) => `nomad:tokens:${a.toLowerCase()}`;
/** Remembers tokens that came into the account (from an agent's wallet), so they show even if the explorer is slow. */
export function rememberTokens(account: Address, tokens: Address[]) {
  try {
    const list = new Set<string>(JSON.parse(localStorage.getItem(KNOWN(account)) ?? "[]"));
    tokens.forEach((t) => list.add(t.toLowerCase()));
    localStorage.setItem(KNOWN(account), JSON.stringify([...list].slice(0, 50)));
  } catch {
    /* storage is optional */
  }
}

const cleanSymbol = (s: unknown) => String(s ?? "?").replace(/[^\p{L}\p{N}$._-]/gu, "").slice(0, 12) || "?";

/**
 * Everything in the account besides $NOMAD and USDG: ETH, tokens the explorer lists, and tokens remembered here.
 * Balances are read from the chain itself; the explorer is only used to find which tokens to look at.
 */
export async function otherHoldings(account: Address): Promise<Holding[]> {
  const found = new Set<string>();
  try {
    const raw = JSON.parse(localStorage.getItem(KNOWN(account)) ?? "[]") as string[];
    raw.forEach((t) => /^0x[0-9a-fA-F]{40}$/.test(t) && found.add(t.toLowerCase()));
  } catch {
    /* none remembered */
  }
  try {
    const r = await fetch(`https://robinhoodchain.blockscout.com/api/v2/addresses/${account}/token-balances`, { signal: AbortSignal.timeout(8_000) });
    if (r.ok) {
      const list = (await r.json()) as { token?: { address?: string; address_hash?: string; type?: string } }[];
      for (const x of list.slice(0, 50)) {
        const a = x.token?.address_hash ?? x.token?.address;
        if (a && /^0x[0-9a-fA-F]{40}$/.test(a) && (x.token?.type ?? "ERC-20") === "ERC-20") found.add(a.toLowerCase());
      }
    }
  } catch {
    /* the remembered list still shows */
  }
  found.delete(NOMAD.toLowerCase());
  found.delete(USDG.toLowerCase());
  const out: Holding[] = [];
  const eth = await publicClient.getBalance({ address: account }).catch(() => 0n);
  if (eth > 0n) out.push({ token: "eth", symbol: "ETH", decimals: 18, amount: eth });
  await Promise.all(
    [...found].map(async (t) => {
      const token = t as Address;
      try {
        const [amount, symbol, decimals] = await Promise.all([
          publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
          publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
          publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })
        ]);
        if (amount > 0n) out.push({ token, symbol: cleanSymbol(symbol), decimals: Number(decimals), amount });
      } catch {
        /* not a readable token */
      }
    })
  );
  return out;
}
