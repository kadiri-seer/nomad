// Builds Safe Transaction Builder batches for the treasury, and keeps the buyback record. Used by safe-batch.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { encodeFunctionData, getAddress, isAddress, parseAbi, parseUnits } from "viem";

export const CHAIN_ID = "4663";
export const NOMAD = "0x14c0a77e792f6c9818888630e95c50cf3b48c979";
export const SAFE = "0xe4862B7605f0CD66796F5d1A9cC936462642b515";
export const BURN = "0x000000000000000000000000000000000000dEaD";
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const AGENTS = parseAbi(["function setMintingOpen(bool open)", "function setMintFee(uint256 fee, uint256 burnBps)", "function setPlatform(uint256 platformBps, uint256 burnBps)"]);

/** Whole $NOMAD ("250000", "1500.5") to base units; anything else, zero or negative is refused. */
export function nomadAmount(v) {
  const s = String(v ?? "").trim();
  if (!/^\d{1,12}(\.\d{1,18})?$/.test(s)) throw new Error(`"${v}" is not an amount of $NOMAD (whole tokens, like 250000)`);
  const units = parseUnits(s, 18);
  if (units === 0n) throw new Error("The amount must be more than 0");
  return units;
}
function bps(v, max, what) {
  const s = String(v ?? "").trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) throw new Error(`"${v}" is not a percentage`);
  const b = BigInt(Math.round(Number(s) * 100));
  if (b > BigInt(max)) throw new Error(`${what} can be at most ${max / 100}%`);
  return b;
}
function address(v, what) {
  if (!isAddress(String(v ?? ""), { strict: false })) throw new Error(`${what} must be an address`);
  return getAddress(String(v));
}

const tx = (to, data, note) => ({ to, value: "0", data, contractMethod: null, contractInputsValues: null, note });

export const burnTx = (amount) => tx(getAddress(NOMAD), encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [BURN, nomadAmount(amount)] }), "burn");

export function bountyTx(to, amount) {
  const a = address(to, "The builder's payout address");
  if (a.toLowerCase() === BURN.toLowerCase() || a.toLowerCase() === SAFE.toLowerCase()) throw new Error("That is not a builder's address");
  return tx(getAddress(NOMAD), encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [a, nomadAmount(amount)] }), "bounty");
}

export function agentsTx(contract, fn, args) {
  const to = address(contract, "The NomadAgents contract");
  let a;
  if (fn === "setMintingOpen") a = [args[0] === true];
  else if (fn === "setMintFee") a = [parseUnits(String(args[0] ?? "").trim() || "x", 18), bps(args[1], 10000, "The burned share")];
  else if (fn === "setPlatform") a = [bps(args[0], 2000, "Nomad's share"), bps(args[1], 10000, "The burned share")];
  else throw new Error(`Unknown setting ${fn}`);
  return tx(to, encodeFunctionData({ abi: AGENTS, functionName: fn, args: a }), fn);
}

/** A batch in the Safe Transaction Builder's file format, for the treasury Safe on Robinhood Chain. */
export function batch(transactions, description, now = Date.now()) {
  return {
    version: "1.0",
    chainId: CHAIN_ID,
    createdAt: now,
    meta: { name: "Nomad treasury", description, txBuilderVersion: "1.18.0", createdFromSafeAddress: SAFE, createdFromOwnerAddress: "" },
    transactions: transactions.map(({ note: _note, ...t }) => t)
  };
}

/** Adds a buyback to governance/economy.json, after checking its fields. Returns the entry. */
export function recordBuyback(file, f) {
  const clean = (v, max) => String(v ?? "").replace(/[^\p{L}\p{N} .,'$()-]/gu, "").trim().slice(0, max);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.date ?? ""))) throw new Error("--date must be YYYY-MM-DD");
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(f.tx ?? ""))) throw new Error("--tx must be the buyback's transaction hash");
  if (f.burnTx !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(String(f.burnTx))) throw new Error("--burn-tx must be a transaction hash");
  if (!clean(f.spent, 40) || !clean(f.bought, 40)) throw new Error('--spent and --bought are needed, like --spent "500 USDG" --bought "1200000 $NOMAD"');
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(record.buybacks)) record.buybacks = [];
  if (record.buybacks.some((b) => String(b.tx).toLowerCase() === String(f.tx).toLowerCase())) throw new Error("That buyback is already recorded");
  const entry = { date: f.date, spent: clean(f.spent, 40), bought: clean(f.bought, 40), tx: f.tx, ...(f.burnTx ? { burnTx: f.burnTx } : {}), ...(f.note ? { note: clean(f.note, 120) } : {}) };
  record.buybacks.push(entry);
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  return entry;
}
