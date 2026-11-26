"use client";

/**
 * The treasury's own wallet, in this browser (an extension such as Trust Wallet or MetaMask): used only to send the
 * two transactions that lock a bounty prize in Bull's escrow. Nomad never sees its key. It must be the treasury
 * address, on Robinhood Chain; every transaction is shown in the wallet before it is sent.
 */
import { numberToHex, type Address, type EIP1193Provider, type Hex } from "viem";
import { CHAIN_ID, PUBLIC_RPC, TREASURY } from "@/lib/accounts/chain";
import { publicClient } from "@/lib/accounts/client";

type Announced = { info: { name: string; rdns?: string }; provider: EIP1193Provider };
const lc = (a: string) => a.toLowerCase();

/** Every wallet extension in this browser (EIP-6963), or the one at window.ethereum. */
async function wallets(): Promise<EIP1193Provider[]> {
  const found: EIP1193Provider[] = [];
  const on = (e: Event) => {
    const d = (e as CustomEvent<Announced>).detail;
    if (d?.provider && !found.includes(d.provider)) found.push(d.provider);
  };
  window.addEventListener("eip6963:announceProvider", on);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, 300));
  window.removeEventListener("eip6963:announceProvider", on);
  const injected = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (injected && !found.includes(injected)) found.push(injected);
  return found;
}

/** The wallet holding the treasury, asked to connect if none has shared it yet. */
export async function treasuryWallet(): Promise<EIP1193Provider> {
  const list = await wallets();
  if (!list.length) throw new Error("No wallet extension found in this browser. Open this page where the treasury wallet is installed.");
  for (const p of list) {
    const accounts = (await p.request({ method: "eth_accounts" }).catch(() => [])) as string[];
    if (accounts.some((a) => lc(a) === lc(TREASURY))) return p;
  }
  for (const p of list) {
    const accounts = (await p.request({ method: "eth_requestAccounts" }).catch(() => [])) as string[];
    if (accounts.some((a) => lc(a) === lc(TREASURY))) return p;
  }
  throw new Error(`Connect the treasury wallet (${TREASURY.slice(0, 6)}...${TREASURY.slice(-4)}) in your wallet extension, then try again.`);
}

async function onRobinhood(p: EIP1193Provider) {
  const id = numberToHex(CHAIN_ID);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: id }] });
  } catch {
    await p.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: id, chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [PUBLIC_RPC], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] }]
    });
  }
  const now = (await p.request({ method: "eth_chainId" })) as string;
  if (Number(now) !== CHAIN_ID) throw new Error("Switch the wallet to Robinhood Chain, then try again.");
}

/** Sends the calls one after the other from the treasury, waiting for each on chain. Returns the last hash. */
export async function sendFromTreasury(p: EIP1193Provider, calls: { to: Address; data: Hex; value: bigint }[]): Promise<Hex> {
  await onRobinhood(p);
  let last: Hex | null = null;
  for (const c of calls) {
    const hash = (await p.request({ method: "eth_sendTransaction", params: [{ from: TREASURY, to: c.to, data: c.data, value: numberToHex(c.value) }] })) as Hex;
    const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success") throw new Error("A transaction from the treasury failed. Nothing was locked.");
    last = hash;
  }
  return last!;
}
