/**
 * Nomad's paymaster service (ERC-7677: pm_getPaymasterStubData and pm_getPaymasterData). It decides whether
 * NomadPaymaster pays for a user operation, and signs it when it does. The treasury pays outright for a few kinds of
 * operation that bring money in or create an agent (a credit top-up, buying $NOMAD, minting), a few a day per
 * account; everything else is paid from the account's credits: the operation's most possible cost is held, and the
 * real cost plus a margin is charged once it lands (credits.ts). Every dependency comes in as an argument, so the
 * rules are tested without the network.
 */
import { concat, decodeFunctionData, encodeAbiParameters, erc20Abi, getAddress, hexToBigInt, keccak256, pad, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { decodeCallsMAv2 } from "@alchemy/smart-accounts";
import { AGENTS_ABI } from "../agents-contract";
import { CHAIN_ID, ENTRY_POINT, FREE_OPS_PER_DAY, MIN_TOPUP_USDG, NOMAD, PAYMASTER_POST_OP_GAS, PAYMASTER_VERIFICATION_GAS, SPONSOR_VALID_SECONDS, STOA_ROUTER, TREASURY, USDG } from "../accounts/chain";

export class SponsorError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** A user operation as ERC-7677 sends it (EntryPoint v0.7, unpacked, hex quantities). */
export type RpcUserOp = {
  sender: Address;
  nonce: Hex;
  factory?: Address | null;
  factoryData?: Hex | null;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
};

const u128 = (v: bigint) => pad(toHex(v), { size: 16 });
const lc = (a: string) => a.toLowerCase();
const DUMMY_SIGNATURE: Hex = `0x${"ff".repeat(32)}${"00".repeat(32)}1b`;

/** The hash NomadPaymaster.getHash computes on-chain, over the same fields. */
export function paymasterHash(op: RpcUserOp, paymaster: Address, validUntil: number, validAfter: number, chainId = CHAIN_ID): Hex {
  const initCode = op.factory ? concat([op.factory, op.factoryData ?? "0x"]) : "0x";
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint48" },
        { type: "uint48" }
      ],
      [
        op.sender,
        hexToBigInt(op.nonce),
        keccak256(initCode),
        keccak256(op.callData),
        concat([u128(hexToBigInt(op.verificationGasLimit)), u128(hexToBigInt(op.callGasLimit))]),
        hexToBigInt(concat([u128(PAYMASTER_VERIFICATION_GAS), u128(PAYMASTER_POST_OP_GAS)])),
        hexToBigInt(op.preVerificationGas),
        concat([u128(hexToBigInt(op.maxPriorityFeePerGas)), u128(hexToBigInt(op.maxFeePerGas))]),
        BigInt(chainId),
        paymaster,
        validUntil,
        validAfter
      ]
    )
  );
}

/** The EntryPoint v0.7 user operation hash, once the paymaster's part is filled in (the account's signature is not part of it). */
export function userOpHash(op: RpcUserOp, paymaster: Address, paymasterData: Hex, chainId = CHAIN_ID, entryPoint: Address = ENTRY_POINT): Hex {
  const initCode = op.factory ? concat([op.factory, op.factoryData ?? "0x"]) : "0x";
  const paymasterAndData = concat([paymaster, u128(PAYMASTER_VERIFICATION_GAS), u128(PAYMASTER_POST_OP_GAS), paymasterData]);
  const packed = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
    [
      op.sender,
      hexToBigInt(op.nonce),
      keccak256(initCode),
      keccak256(op.callData),
      concat([u128(hexToBigInt(op.verificationGasLimit)), u128(hexToBigInt(op.callGasLimit))]),
      hexToBigInt(op.preVerificationGas),
      concat([u128(hexToBigInt(op.maxPriorityFeePerGas)), u128(hexToBigInt(op.maxFeePerGas))]),
      keccak256(paymasterAndData)
    ]
  );
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [keccak256(packed), entryPoint, BigInt(chainId)]));
}

/** The most this operation can cost, in wei: every gas limit at the highest fee it allows. */
export function maxCostWei(op: RpcUserOp): bigint {
  const gas = hexToBigInt(op.verificationGasLimit) + hexToBigInt(op.callGasLimit) + hexToBigInt(op.preVerificationGas) + PAYMASTER_VERIFICATION_GAS + PAYMASTER_POST_OP_GAS;
  return gas * hexToBigInt(op.maxFeePerGas);
}

export type Kind = "topup" | "buy-nomad" | "mint" | "paid";

/**
 * What an operation does, from its calls. The treasury pays only when every call is part of one of these, exactly:
 *   topup:     USDG sent to the treasury (at least MIN_TOPUP_USDG), or a Stoa swap paying out to the treasury;
 *   buy-nomad: a Stoa swap from USDG to $NOMAD (with its USDG approval);
 *   mint:      minting a Nomad agent (with its $NOMAD approval to the agents contract).
 * Anything else, or any mix with anything else, is paid from credits.
 */
export function classify(callData: Hex, sender: Address, agents: Address | ""): Kind {
  let calls: readonly { to: Address; data?: Hex; value?: bigint }[];
  try {
    calls = decodeCallsMAv2(callData, sender);
  } catch {
    return "paid";
  }
  if (!calls.length) return "paid";
  const kinds = new Set<Kind>();
  for (const c of calls) {
    if ((c.value ?? 0n) !== 0n) return "paid";
    const to = lc(c.to);
    const data = c.data ?? "0x";
    if (to === lc(USDG) || to === lc(NOMAD)) {
      let d;
      try {
        d = decodeFunctionData({ abi: erc20Abi, data });
      } catch {
        return "paid";
      }
      if (d.functionName === "transfer" && to === lc(USDG) && lc(d.args[0] as string) === lc(TREASURY) && (d.args[1] as bigint) >= MIN_TOPUP_USDG) kinds.add("topup");
      else if (d.functionName === "approve" && lc(d.args[0] as string) === lc(STOA_ROUTER)) continue;
      else if (d.functionName === "approve" && to === lc(NOMAD) && agents && lc(d.args[0] as string) === lc(agents)) continue;
      else return "paid";
    } else if (to === lc(STOA_ROUTER)) {
      const swap = stoaSwap(data);
      if (!swap) return "paid";
      if (lc(swap.to) === lc(TREASURY) && lc(swap.tokenOut) === lc(USDG)) kinds.add("topup");
      else if (lc(swap.to) === lc(sender) && lc(swap.tokenIn) === lc(USDG) && lc(swap.tokenOut) === lc(NOMAD)) kinds.add("buy-nomad");
      else return "paid";
    } else if (agents && to === lc(agents)) {
      try {
        if (decodeFunctionData({ abi: AGENTS_ABI, data }).functionName !== "mint") return "paid";
      } catch {
        return "paid";
      }
      kinds.add("mint");
    } else {
      return "paid";
    }
  }
  // Approvals alone, or more than one purpose in one operation, are not free.
  if (kinds.size !== 1) return kinds.has("mint") && kinds.has("buy-nomad") && kinds.size === 2 ? "mint" : "paid";
  return [...kinds][0];
}

/** Stoa's router swap, as its public API encodes it: swap((tokenIn, tokenOut, mid, leg1, leg2, amountIn, minOut, to, deadline, referrer)). */
const STOA_SWAP_ABI = [
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "mid", type: "address" },
          { name: "leg1", type: "tuple", components: [{ name: "venue", type: "address" }, { name: "isPool", type: "bool" }] },
          { name: "leg2", type: "tuple", components: [{ name: "venue", type: "address" }, { name: "isPool", type: "bool" }] },
          { name: "amountIn", type: "uint256" },
          { name: "minOut", type: "uint256" },
          { name: "to", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "referrer", type: "address" }
        ]
      }
    ],
    outputs: [{ type: "uint256" }]
  }
] as const;

export function stoaSwap(data: Hex): { tokenIn: Address; tokenOut: Address; to: Address; amountIn: bigint } | null {
  try {
    const d = decodeFunctionData({ abi: STOA_SWAP_ABI, data });
    const p = d.args[0];
    return { tokenIn: p.tokenIn, tokenOut: p.tokenOut, to: p.to, amountIn: p.amountIn };
  } catch {
    return null;
  }
}

export type SponsorDeps = {
  paymaster: Address | "";
  agents: Address | "";
  signer: LocalAccount;
  /** Records an operation the treasury pays outright; false once the account used today's free operations. */
  useFreeOp: (account: Address, day: string) => Promise<boolean>;
  /**
   * Holds the operation's most possible cost (wei) against the account's credits, under its user operation hash
   * (to settle at the real cost once it lands, or release once it expires); false when the credits do not cover it.
   */
  hold: (account: Address, maxCostWei: bigint, userOpHash: Hex, validUntil: number) => Promise<boolean>;
  now?: () => Date;
};

function parseOp(raw: unknown): RpcUserOp {
  const o = (raw ?? {}) as Record<string, unknown>;
  const hex = (k: string) => {
    const v = o[k];
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) throw new SponsorError(400, `userOp.${k} is missing or not hex.`);
    return v as Hex;
  };
  const sender = hex("sender");
  if (!/^0x[0-9a-fA-F]{40}$/.test(sender)) throw new SponsorError(400, "userOp.sender is not an address.");
  const factory = typeof o.factory === "string" && o.factory !== "0x" ? (getAddress(o.factory) as Address) : null;
  return {
    sender: getAddress(sender),
    nonce: hex("nonce"),
    factory,
    factoryData: factory ? hex("factoryData") : null,
    callData: hex("callData"),
    callGasLimit: hex("callGasLimit"),
    verificationGasLimit: hex("verificationGasLimit"),
    preVerificationGas: hex("preVerificationGas"),
    maxFeePerGas: hex("maxFeePerGas"),
    maxPriorityFeePerGas: hex("maxPriorityFeePerGas")
  };
}

function checkTarget(entryPoint: unknown, chainId: unknown) {
  if (typeof entryPoint !== "string" || lc(entryPoint) !== lc(ENTRY_POINT)) throw new SponsorError(400, "Only the v0.7 EntryPoint is supported.");
  const id = typeof chainId === "string" ? Number(BigInt(chainId)) : Number(chainId);
  if (id !== CHAIN_ID) throw new SponsorError(400, "Only Robinhood Chain (4663) is supported.");
}

const gasFields = { paymasterVerificationGasLimit: toHex(PAYMASTER_VERIFICATION_GAS), paymasterPostOpGasLimit: toHex(PAYMASTER_POST_OP_GAS) };

/** pm_getPaymasterStubData: a placeholder of the right size, for gas estimation. Nothing is decided or held yet. */
export function stubData(deps: Pick<SponsorDeps, "paymaster">, params: unknown[]) {
  if (!deps.paymaster) throw new SponsorError(503, "Gas is not set up on this site yet.");
  checkTarget(params[1], params[2]);
  parseOp(params[0]);
  const window = encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [0, 0]);
  return { paymaster: deps.paymaster, paymasterData: concat([window, DUMMY_SIGNATURE]), ...gasFields, isFinal: false };
}

/**
 * pm_getPaymasterData: decides who pays, holds the cost against credits when the account pays, and signs. The
 * signature covers every field of the operation, so it cannot be reused for anything else, and it expires.
 */
export async function sponsor(deps: SponsorDeps, params: unknown[]) {
  if (!deps.paymaster) throw new SponsorError(503, "Gas is not set up on this site yet.");
  checkTarget(params[1], params[2]);
  const op = parseOp(params[0]);
  const now = (deps.now ?? (() => new Date()))();
  const validUntil = Math.floor(now.getTime() / 1000) + SPONSOR_VALID_SECONDS;
  const kind = classify(op.callData, op.sender, deps.agents);
  let paidBy: "treasury" | "credits" = "credits";
  if (kind !== "paid" && (await deps.useFreeOp(op.sender, now.toISOString().slice(0, 10)))) paidBy = "treasury";
  const hash = paymasterHash(op, deps.paymaster, validUntil, 0);
  const signature = await deps.signer.signMessage({ message: { raw: hash } });
  const window = encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [validUntil, 0]);
  const paymasterData = concat([window, signature]);
  if (paidBy === "credits" && !(await deps.hold(op.sender, maxCostWei(op), userOpHash(op, deps.paymaster, paymasterData), validUntil))) {
    throw new SponsorError(402, "Not enough credits for this. Add credits, then try again.");
  }
  return { paymaster: deps.paymaster, paymasterData, ...gasFields, kind, paidBy };
}

export const FREE_LIMIT = FREE_OPS_PER_DAY;
