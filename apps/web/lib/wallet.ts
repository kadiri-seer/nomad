/**
 * The browser wallet (EIP-1193), for transactions on Robinhood Chain: connect, switch to the chain, read through
 * the wallet's own connection, send and wait. Every transaction is shown and signed in the wallet; the site never
 * holds a key.
 */
import { decodeFunctionResult, encodeFunctionData, type Abi } from "viem";
import { EXPLORER } from "./token";

export const CHAIN_ID = 4663;
const CHAIN_HEX = "0x1237";
export const CHAIN_PARAMS = {
  chainId: CHAIN_HEX,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: [EXPLORER]
};

export type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

export function getWallet(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) as Eip1193 | null;
}

/** A wallet error in plain words. */
export function walletMessage(e: unknown): string {
  const err = e as { code?: number; message?: string; shortMessage?: string };
  if (err?.code === 4001) return "You cancelled it in your wallet. Nothing was sent.";
  const m = String(err?.shortMessage ?? err?.message ?? e);
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
}

export async function connect(eth: Eip1193): Promise<`0x${string}`> {
  const list = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (!list?.[0]) throw new Error("Your wallet did not share an account.");
  await ensureChain(eth);
  return list[0] as `0x${string}`;
}

/** Switches the wallet to Robinhood Chain, adding the chain first if the wallet does not know it. */
export async function ensureChain(eth: Eip1193): Promise<void> {
  const current = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
  if (current === CHAIN_HEX) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    if ((e as { code?: number })?.code !== 4902) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] });
  }
  const after = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
  if (after !== CHAIN_HEX) throw new Error("Switch your wallet to Robinhood Chain and try again.");
}

/** A contract read through the wallet's own connection. */
export async function readContract<T>(eth: Eip1193, address: string, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  const raw = (await eth.request({ method: "eth_call", params: [{ to: address, data }, "latest"] })) as `0x${string}`;
  return decodeFunctionResult({ abi, functionName, data: raw } as Parameters<typeof decodeFunctionResult>[0]) as T;
}

/** Sends a transaction from the wallet (it shows it and asks first) and returns its hash. */
export async function send(eth: Eip1193, from: string, tx: { to?: string; data: `0x${string}`; value?: `0x${string}` }): Promise<`0x${string}`> {
  await ensureChain(eth);
  return (await eth.request({ method: "eth_sendTransaction", params: [{ from, ...tx }] })) as `0x${string}`;
}

export type Receipt = { status: string; contractAddress?: string | null; transactionHash: string };

/** Waits for a transaction to be mined (up to about three minutes). */
export async function waitFor(eth: Eip1193, hash: string): Promise<Receipt> {
  for (let i = 0; i < 90; i++) {
    const r = (await eth.request({ method: "eth_getTransactionReceipt", params: [hash] })) as Receipt | null;
    if (r) {
      if (r.status !== "0x1") throw new Error("The transaction failed on-chain. Nothing was changed.");
      return r;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("The transaction has not been confirmed yet. Check it on the explorer before trying again.");
}

/** Asks the wallet to sign a plain-text message (free; nothing is sent on chain). */
export async function signMessage(eth: Eip1193, address: string, message: string): Promise<string> {
  const hex = `0x${[...new TextEncoder().encode(message)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return (await eth.request({ method: "personal_sign", params: [hex, address] })) as string;
}

/** The SHA-256 of a file, as a 0x-prefixed 32-byte hex value. */
export async function sha256File(file: Blob): Promise<`0x${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return `0x${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
