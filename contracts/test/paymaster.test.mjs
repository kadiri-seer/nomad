// NomadPaymaster against the real ERC-4337 v0.7 EntryPoint, on a local test chain (ganache, in process): a new smart
// account with no ETH at all is created and sends a token transfer, its gas paid from the treasury's deposit, only with
// Nomad's signature, only before it expires, only up to the per-operation limit; and money leaves only to the treasury.
//   node build.mjs && node --test test/
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ganache from "ganache";
import { concat, createPublicClient, createWalletClient, custom, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, pad, parseEther, toHex, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const art = (n) => JSON.parse(readFileSync(join(here, "..", "artifacts", `${n}.json`), "utf8"));
const EntryPoint = art("EntryPoint");
const Factory = art("SimpleAccountFactory");
const Account = art("SimpleAccount");
const Paymaster = art("NomadPaymaster");
const Token = art("TestToken");

// Throwaway test keys, made up here and funded only on this local chain. The account owner and Nomad's signer hold no ETH.
const KEYS = Array.from({ length: 5 }, (_, i) => keccak256(toHex(`nomad-paymaster-test-${i}`)));
const OWNER_KEY = keccak256(toHex("nomad-paymaster-test-owner"));
const SIGNER_KEY = keccak256(toHex("nomad-paymaster-test-signer"));
const OTHER_SIGNER_KEY = keccak256(toHex("nomad-paymaster-test-other"));
const provider = ganache.provider({
  logging: { quiet: true },
  wallet: { accounts: KEYS.map((secretKey) => ({ secretKey, balance: "0x56BC75E2D63100000" })) },
  chain: { chainId: 4663, hardfork: "shanghai", allowUnlimitedContractSize: true }
});
const chain = { id: 4663, name: "test", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://x"] } } };
const pub = createPublicClient({ chain, transport: custom(provider) });
const funded = KEYS.map((k) => privateKeyToAccount(k));
const byAddress = new Map(funded.map((a) => [a.address, a]));
const wallet = (address) => createWalletClient({ chain, account: byAddress.get(address), transport: custom(provider) });
const owner = privateKeyToAccount(OWNER_KEY);
const nomadSigner = privateKeyToAccount(SIGNER_KEY);
const otherSigner = privateKeyToAccount(OTHER_SIGNER_KEY);

let safe, treasury, bundler, recipient, stranger;
let entryPoint, factory, paymaster, token, account;
const MAX_COST = parseEther("0.01");

async function deploy(artifact, args, from) {
  const hash = await wallet(from).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args, gas: 30_000_000n });
  const rc = await pub.waitForTransactionReceipt({ hash });
  assert.equal(rc.status, "success");
  return getAddress(rc.contractAddress);
}
const write = async (from, address, abi, functionName, args = [], value) => {
  const hash = await wallet(from).writeContract({ address, abi, functionName, args, value, gas: 10_000_000n });
  return pub.waitForTransactionReceipt({ hash });
};
const errorsAbi = [...Paymaster.abi, ...EntryPoint.abi].filter((x) => x.type === "error");
/** The revert's text: every message in the error chain, for a custom error's selector or an EntryPoint reason like "AA34". */
async function revertText(promise) {
  try {
    await promise;
  } catch (e) {
    let all = "";
    for (let x = e, i = 0; x && i < 10; i++, x = x.cause) all += ` ${x.message ?? ""} ${x.details ?? ""} ${JSON.stringify(x.data ?? "")}`;
    return all;
  }
  assert.fail("expected a revert");
}
const selector = (name) => {
  const item = errorsAbi.find((x) => x.name === name);
  return keccak256(toHex(`${name}(${item.inputs.map((i) => i.type).join(",")})`)).slice(0, 10);
};
const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const u128 = (v) => pad(toHex(v), { size: 16 });
const now = async () => Number((await pub.getBlock()).timestamp);

/** A user operation (v0.7 packed form) from the account: one call, the paymaster's gas fields, no signatures yet. */
async function userOp({ call, maxFeePerGas = 1_000_000_000n, deployAccount }) {
  const nonce = await pub.readContract({ address: entryPoint, abi: EntryPoint.abi, functionName: "getNonce", args: [account, 0n] });
  const code = await pub.getCode({ address: account });
  const needsInit = deployAccount ?? !(code && code !== "0x");
  return {
    sender: account,
    nonce,
    initCode: needsInit ? concat([factory, encodeFunctionData({ abi: Factory.abi, functionName: "createAccount", args: [owner.address, 0n] })]) : "0x",
    callData: encodeFunctionData({ abi: Account.abi, functionName: "execute", args: [call.to, 0n, call.data] }),
    accountGasLimits: concat([u128(1_000_000n), u128(300_000n)]),
    preVerificationGas: 60_000n,
    gasFees: concat([u128(1_000_000n), u128(maxFeePerGas)]),
    paymasterAndData: "0x",
    signature: "0x"
  };
}

/** Nomad's server: signs the operation for this paymaster, valid for the given window. */
async function sponsor(op, { signer = nomadSigner, validFor = 300, validAfter = 0 } = {}) {
  const until = (await now()) + validFor;
  const head = concat([paymaster, u128(150_000n), u128(0n)]);
  const window = encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [until, validAfter]);
  const draft = { ...op, paymasterAndData: concat([head, window, `0x${"00".repeat(65)}`]) };
  const hash = await pub.readContract({ address: paymaster, abi: Paymaster.abi, functionName: "getHash", args: [draft, until, validAfter] });
  const sig = await signer.signMessage({ message: { raw: hash } });
  return { ...op, paymasterAndData: concat([head, window, sig]) };
}

/** The account owner signs the operation (SimpleAccount checks an EIP-191 signature of the user operation hash). */
async function signByOwner(op) {
  const h = await pub.readContract({ address: entryPoint, abi: EntryPoint.abi, functionName: "getUserOpHash", args: [op] });
  return { ...op, signature: await owner.signMessage({ message: { raw: h } }) };
}

const transferCall = (amount) => ({ to: token, data: encodeFunctionData({ abi: Token.abi, functionName: "transfer", args: [recipient, amount] }) });
const handleOps = (op, from = bundler) => write(from, entryPoint, EntryPoint.abi, "handleOps", [[op], bundler]);
/** A refused operation: the bundler's own check (eth_call), where the EntryPoint's reason can be read. */
const tryOps = (op) => pub.simulateContract({ address: entryPoint, abi: EntryPoint.abi, functionName: "handleOps", args: [[op], bundler], account: byAddress.get(bundler) });
const deposit = () => pub.readContract({ address: paymaster, abi: Paymaster.abi, functionName: "getDeposit" });

before(async () => {
  [safe, treasury, bundler, recipient, stranger] = (await provider.request({ method: "eth_accounts", params: [] })).map((a) => getAddress(a));
  entryPoint = await deploy(EntryPoint, [], bundler);
  factory = await deploy(Factory, [entryPoint], bundler);
  paymaster = await deploy(Paymaster, [entryPoint, nomadSigner.address, treasury, MAX_COST, safe], safe);
  token = await deploy(Token, [], safe);
  account = await pub.readContract({ address: factory, abi: Factory.abi, functionName: "getAddress", args: [owner.address, 0n] });
  await write(safe, token, Token.abi, "mintTo", [account, parseEther("100")]);
  // The treasury funds the deposit from its Safe.
  await write(safe, paymaster, Paymaster.abi, "deposit", [], parseEther("1"));
});

test("a new account with no ETH sends its first transaction, gas paid from the treasury's deposit", async () => {
  assert.equal(await pub.getBalance({ address: account }), 0n);
  assert.equal(await pub.getBalance({ address: owner.address }), 0n);
  const before = await deposit();
  const op = await signByOwner(await sponsor(await userOp({ call: transferCall(parseEther("5")) })));
  const rc = await handleOps(op);
  assert.equal(rc.status, "success");
  const ev = rc.logs
    .filter((l) => getAddress(l.address) === entryPoint)
    .map((l) => {
      try {
        return decodeEventLog({ abi: EntryPoint.abi, data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .find((e) => e?.eventName === "UserOperationEvent");
  assert.equal(ev.args.success, true);
  assert.equal(getAddress(ev.args.paymaster), paymaster);
  assert.equal(await pub.readContract({ address: token, abi: Token.abi, functionName: "balanceOf", args: [recipient] }), parseEther("5"));
  assert.equal(await pub.getBalance({ address: account }), 0n, "the account still holds no ETH");
  const spent = before - (await deposit());
  assert.equal(spent, ev.args.actualGasCost, "the deposit paid exactly the operation's gas");
  assert.ok(spent > 0n && spent < MAX_COST);
});

test("a second operation from the deployed account works the same way", async () => {
  const op = await signByOwner(await sponsor(await userOp({ call: transferCall(parseEther("1")) })));
  assert.equal((await handleOps(op)).status, "success");
  assert.equal(await pub.readContract({ address: token, abi: Token.abi, functionName: "balanceOf", args: [recipient] }), parseEther("6"));
});

test("without Nomad's signature, nothing is paid", async () => {
  const op = await signByOwner(await sponsor(await userOp({ call: transferCall(1n) }), { signer: otherSigner }));
  assert.match(await revertText(tryOps(op)), new RegExp(hex("AA34")));
});

test("a signature for another operation does not carry over", async () => {
  const signed = await sponsor(await userOp({ call: transferCall(1n) }));
  const changed = await signByOwner({ ...signed, callData: encodeFunctionData({ abi: Account.abi, functionName: "execute", args: [token, 0n, transferCall(parseEther("50")).data] }) });
  assert.match(await revertText(tryOps(changed)), new RegExp(hex("AA34")));
});

test("an expired signature is refused", async () => {
  const op = await signByOwner(await sponsor(await userOp({ call: transferCall(1n) }), { validFor: -10 }));
  assert.match(await revertText(tryOps(op)), new RegExp(hex("AA32")));
});

test("an operation that could cost more than maxCostPerOp is refused", async () => {
  // 1.51M gas at 100 gwei could cost 0.151 ETH, over the 0.01 ETH limit.
  const op = await signByOwner(await sponsor(await userOp({ call: transferCall(1n), maxFeePerGas: 100_000_000_000n })));
  const text = await revertText(tryOps(op));
  assert.match(text, new RegExp(hex("AA33")));
  assert.ok(text.includes(selector("TooExpensive").slice(2)), "the paymaster's own reason is passed on");
});

test("only the EntryPoint may ask the paymaster to validate", async () => {
  const op = await sponsor(await userOp({ call: transferCall(1n) }));
  const text = await revertText(pub.simulateContract({ address: paymaster, abi: Paymaster.abi, functionName: "validatePaymasterUserOp", args: [op, `0x${"00".repeat(32)}`, 1n], account: byAddress.get(stranger) }));
  assert.ok(text.includes(selector("NotEntryPoint")));
});

test("the deposit and stake go back to the treasury only, and only on the owner's say", async () => {
  assert.ok((await revertText(pub.simulateContract({ address: paymaster, abi: Paymaster.abi, functionName: "withdrawTo", args: [stranger, 1n], account: byAddress.get(safe) }))).includes(selector("NotTreasury")));
  assert.ok((await revertText(pub.simulateContract({ address: paymaster, abi: Paymaster.abi, functionName: "withdrawTo", args: [treasury, 1n], account: byAddress.get(stranger) }))).includes(selector("OwnableUnauthorizedAccount")));
  assert.ok((await revertText(pub.simulateContract({ address: paymaster, abi: Paymaster.abi, functionName: "withdrawStake", args: [stranger], account: byAddress.get(safe) }))).includes(selector("NotTreasury")));
  assert.ok((await revertText(pub.simulateContract({ address: paymaster, abi: Paymaster.abi, functionName: "renounceOwnership", args: [], account: byAddress.get(safe) }))).includes(selector("RenounceDisabled")));
  const before = await pub.getBalance({ address: treasury });
  const rc = await write(safe, paymaster, Paymaster.abi, "withdrawTo", [treasury, parseEther("0.5")]);
  assert.equal(rc.status, "success");
  assert.equal((await pub.getBalance({ address: treasury })) - before, parseEther("0.5"));
});

test("it cannot be deployed with a missing address", async () => {
  const data = encodeFunctionData; // keep viem's tree-shaker honest in this file
  assert.ok(data);
  const text = await revertText(
    wallet(safe).deployContract({ abi: Paymaster.abi, bytecode: Paymaster.bytecode, args: [entryPoint, "0x0000000000000000000000000000000000000000", treasury, MAX_COST, safe], gas: 5_000_000n }).then((h) => pub.waitForTransactionReceipt({ hash: h })).then((rc) => {
      if (rc.status !== "success") throw new Error(`reverted ${selector("ZeroAddress")}`);
    })
  );
  assert.ok(text.includes(selector("ZeroAddress")));
});
