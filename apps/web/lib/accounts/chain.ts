/**
 * Nomad accounts on Robinhood Chain: the addresses and settings the account pages and their server routes share.
 * Each person signs in with Google (Privy holds the key behind it), gets a smart account (Modular Account V2) on
 * Robinhood Chain, and pays for things in $NOMAD or USDG. Gas is paid by NomadPaymaster from the treasury's deposit
 * and charged to the account's credits.
 */
import type { Address } from "viem";
import { REWARD_SAFE, TOKEN_CA } from "../token";
import { USDG as USDG_ADDRESS } from "../agent";

export const CHAIN_ID = 4663;
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
/** The ERC-4337 v0.7 EntryPoint (deployed on Robinhood Chain at its standard address). */
export const ENTRY_POINT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
/** Stoa's router on Robinhood Chain, for swaps ("Get $NOMAD", $NOMAD credit top-ups). */
export const STOA_ROUTER: Address = "0x2F2804fad735a38015650f32f95Ad5E08D6B3eE5";
export const STOA_QUOTE_API = "https://stoadex.com/api/v1/quote";
export const USDG: Address = USDG_ADDRESS as Address;
export const NOMAD: Address = TOKEN_CA as Address;
export const TREASURY: Address = REWARD_SAFE as Address;

/** Set in the deployment's environment once each contract is deployed; empty until then. */
export const PAYMASTER = (process.env.NEXT_PUBLIC_NOMAD_PAYMASTER ?? "").trim() as Address | "";
export const PRIVY_APP_ID = (process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "").trim();

/** Gas limits the paymaster's part of every operation uses (it reads no storage and has no postOp). */
export const PAYMASTER_VERIFICATION_GAS = 60_000n;
export const PAYMASTER_POST_OP_GAS = 0n;
/** How long a sponsorship signature stays valid. */
export const SPONSOR_VALID_SECONDS = 600;
/** Credits are charged the gas cost plus this share, so the treasury is repaid with a margin. */
export const GAS_MARGIN_BPS = 2_500n;
/** Operations the treasury pays outright, per account per UTC day (minting, credit top-ups, buying $NOMAD). */
export const FREE_OPS_PER_DAY = 6;
/** Extra credits for topping up with $NOMAD instead of USDG. */
export const NOMAD_TOPUP_BONUS_BPS = 1_000n;
/** The smallest top-up that counts, in USDG (6 decimals). */
export const MIN_TOPUP_USDG = 1_000_000n;
