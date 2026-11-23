/**
 * The account pages' side of Nomad accounts: the person's smart account (Modular Account V2, owned by the wallet
 * Privy keeps behind their Google sign-in), sending its operations through Nomad's bundler route with gas from
 * NomadPaymaster, balances, Stoa quotes and the calls for each action. Runs in the browser.
 */
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, http, keccak256, parseUnits, toHex, type Address, type EIP1193Provider, type Hex } from "viem";
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
export async function accountClient(owner: ReturnType<typeof ownerFromProvider>) {
  const account = await toModularAccountV2({ client: publicClient, owner });
  const bundler = createBundlerClient({
    account,
    client: publicClient,
    chain: robinhood,
    transport: http("/api/account/bundler"),
    paymaster: createPaymasterClient({ transport: http("/api/account/paymaster") }),
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
  return { account, bundler };
}

/** Sends calls as one operation and waits for it on-chain. */
export async function send(client: Awaited<ReturnType<typeof accountClient>>, calls: Call[]): Promise<{ userOpHash: Hex; txHash: Hex }> {
  const userOpHash = await client.bundler.sendUserOperation({ calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })) });
  const receipt = await client.bundler.waitForUserOperationReceipt({ hash: userOpHash, timeout: 120_000 });
  if (!receipt.success) throw new Error("The transaction did not go through. Nothing was charged.");
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
export function agentPackage(input: { name: string; template: string; perTradeUsd: string; tradesPerDay: number; instructions?: string }) {
  const body = JSON.stringify({ v: 1, ...input });
  return { body, hash: keccak256(toHex(body)) };
}

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
