/**
 * Keeps the agent mint fee at a dollar price ($5 by default, $1 of it burned) through NomadFeeKeeper. Nomad's fee
 * keeper wallet (derived from AGENT_RUNNER_SECRET) deploys the contract as its first transaction, so its address is
 * known in advance; the treasury wallet then hands NomadAgents to it, and from then on each check moves the fee
 * toward $5 at Stoa's price. The contract itself limits the keeper to the fee: within bounds the treasury wallet set,
 * at most 25% per change, at most every 5 minutes.
 */
import { createPublicClient, createWalletClient, getContractAddress, http, parseAbi, type Address, type Hex } from "viem";
import { CHAIN_ID, NOMAD, PUBLIC_RPC, TREASURY, USDG } from "../accounts/chain";
import { AGENTS_CONTRACT } from "../economy";
import { FEE_KEEPER_ABI, FEE_KEEPER_BYTECODE } from "../fee-keeper-contract";
import { feeKeeperSigner } from "./runner-keys";

const chain = { id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [PUBLIC_RPC] } } } as const;
const WEI = 10n ** 18n;

/** The fee in dollars and how much of it is burned; the contract's bounds (in $NOMAD) and burn share. */
export const FEE_USD = 5;
export const BURN_BPS = 2000n; // $1 of $5
export const MIN_FEE = 16_000n * WEI;
export const MAX_FEE = 400_000n * WEI;
/** Changes smaller than this are not worth a transaction. */
export const DRIFT_BPS = 300n;
const STEP_BPS = 2400n; // just inside the contract's 25%

const AGENTS_ABI = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)", "function mintFee() view returns (uint256)"]);

/** The fee to set now, or null: toward the target, at most one step from the current fee, within the bounds. */
export function nextFee(current: bigint, target: bigint): bigint | null {
  if (current <= 0n || target <= 0n) return null;
  const diff = target > current ? target - current : current - target;
  if (diff * 10_000n < current * DRIFT_BPS) return null;
  const step = (current * STEP_BPS) / 10_000n;
  let fee = target > current ? (target - current > step ? current + step : target) : current - target > step ? current - step : target;
  fee = (fee / WEI) * WEI; // whole $NOMAD
  if (fee < MIN_FEE) fee = MIN_FEE;
  if (fee > MAX_FEE) fee = MAX_FEE;
  return fee === current ? null : fee;
}

export type KeeperState = {
  at: string;
  state: "not-set-up" | "needs-eth" | "deployed" | "waiting-for-handover" | "took-over" | "ok" | "updated" | "waiting" | "error";
  wallet: Address;
  contract: Address;
  feeNomad?: number;
  targetNomad?: number;
  tx?: Hex;
  detail?: string;
};

export function keeperAddresses(secret: Hex) {
  const wallet = feeKeeperSigner(secret).address;
  return { wallet, contract: getContractAddress({ from: wallet, nonce: 0n }) };
}

export async function feeKeeperStep(secret: Hex, quoteNomadForUsdg: (usdg: bigint) => Promise<bigint>): Promise<KeeperState> {
  const account = feeKeeperSigner(secret);
  const { wallet, contract } = keeperAddresses(secret);
  const base = { at: new Date().toISOString(), wallet, contract };
  if (!AGENTS_CONTRACT) return { ...base, state: "not-set-up", detail: "NEXT_PUBLIC_AGENTS_CONTRACT is not set" };
  const agents = AGENTS_CONTRACT as Address;
  const pub = createPublicClient({ chain, transport: http(PUBLIC_RPC, { timeout: 20_000 }) });
  const send = createWalletClient({ account, chain, transport: http(PUBLIC_RPC, { timeout: 20_000 }) });
  try {
    const code = await pub.getCode({ address: contract });
    if (!code || code === "0x") {
      const [balance, nonce] = await Promise.all([pub.getBalance({ address: wallet }), pub.getTransactionCount({ address: wallet })]);
      if (nonce !== 0) return { ...base, state: "error", detail: "The keeper wallet already sent a transaction, so the contract address moved. Nothing was deployed." };
      if (balance < 20_000_000_000_000n) return { ...base, state: "needs-eth", detail: "Send about 0.0005 ETH on Robinhood Chain to the keeper wallet." };
      const tx = await send.deployContract({ abi: FEE_KEEPER_ABI, bytecode: FEE_KEEPER_BYTECODE, args: [agents, TREASURY as Address, wallet, BURN_BPS, MIN_FEE, MAX_FEE] });
      return { ...base, state: "deployed", tx };
    }
    const [owner, pending] = await Promise.all([pub.readContract({ address: agents, abi: AGENTS_ABI, functionName: "owner" }), pub.readContract({ address: agents, abi: AGENTS_ABI, functionName: "pendingOwner" })]);
    if (owner.toLowerCase() !== contract.toLowerCase()) {
      if (pending.toLowerCase() === contract.toLowerCase()) {
        const tx = await send.writeContract({ address: contract, abi: FEE_KEEPER_ABI, functionName: "acceptAgentsOwnership" });
        return { ...base, state: "took-over", tx };
      }
      return { ...base, state: "waiting-for-handover", detail: "The treasury wallet has not handed NomadAgents to the keeper contract yet." };
    }
    const [current, last] = await Promise.all([pub.readContract({ address: agents, abi: AGENTS_ABI, functionName: "mintFee" }), pub.readContract({ address: contract, abi: FEE_KEEPER_ABI, functionName: "lastUpdate" })]);
    const target = ((await quoteNomadForUsdg(BigInt(FEE_USD) * 1_000_000n)) / WEI) * WEI;
    const nums = { feeNomad: Number(current / WEI), targetNomad: Number(target / WEI) };
    const fee = nextFee(current, target);
    if (fee === null) return { ...base, ...nums, state: "ok" };
    if (BigInt(Math.floor(Date.now() / 1000)) < (last as bigint) + 300n) return { ...base, ...nums, state: "waiting", detail: "changed less than 5 minutes ago" };
    const tx = await send.writeContract({ address: contract, abi: FEE_KEEPER_ABI, functionName: "updateFee", args: [fee] });
    return { ...base, ...nums, state: "updated", tx, detail: `set to ${Number(fee / WEI)} $NOMAD` };
  } catch (e) {
    return { ...base, state: "error", detail: String((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? e).replace(/https?:\/\/\S+/g, "").slice(0, 200) };
  }
}

export { NOMAD, USDG };

/** One keeper check from a scheduled run: at most every 10 minutes, its result kept for the status page. */
export async function runFeeKeeper(store: { lock(n: string, s: number): Promise<boolean>; cacheSet(k: string, v: unknown, s: number): Promise<void> }, secret: Hex) {
  if (process.env.FEE_KEEPER === "off") return null;
  if (!(await store.lock("fee-keeper", 600))) return null;
  const { stoa } = await import("./stoa");
  const s = stoa();
  const state = await feeKeeperStep(secret, async (usdg) => (await s.quote(USDG as Address, NOMAD as Address, usdg, TREASURY as Address)).amountOut);
  await store.cacheSet("fee-keeper-state", state, 7 * 86400);
  return state;
}
