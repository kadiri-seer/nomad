// NomadAgents on a local test chain (ganache, in process): minting, fees, copies, limits and who may change what.
//   node build.mjs && node --test test/
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ganache from "ganache";
import { createPublicClient, createWalletClient, custom, encodeDeployData, getAddress, parseUnits, zeroHash, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const art = (n) => JSON.parse(readFileSync(join(here, "..", "artifacts", `${n}.json`), "utf8"));
const Agents = art("NomadAgents");
const Token = art("TestToken");
const BURN = "0x000000000000000000000000000000000000dEaD";
const N = (v) => parseUnits(String(v), 18);

// Throwaway test accounts, made up here and funded only on this local chain.
const KEYS = Array.from({ length: 6 }, (_, i) => keccak256(toHex(`nomad-agents-test-${i}`)));
const provider = ganache.provider({
  logging: { quiet: true },
  wallet: { accounts: KEYS.map((secretKey) => ({ secretKey, balance: "0x56BC75E2D63100000" })) },
  chain: { chainId: 4663, hardfork: "shanghai" }
});
const chain = { id: 4663, name: "test", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://x"] } } };
const pub = createPublicClient({ chain, transport: custom(provider) });
const signers = KEYS.map((k) => privateKeyToAccount(k));
const byAddress = new Map(signers.map((a) => [a.address, a]));
const wallet = (address) => createWalletClient({ chain, account: byAddress.get(address), transport: custom(provider) });

let safe, treasury, alice, bob, carol, stranger;
let token, agents;

async function deploy(artifact, args, from) {
  const hash = await wallet(from).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  assert.equal(rc.status, "success");
  return getAddress(rc.contractAddress);
}
/** Deploying with bad settings: checked with eth_call first, so the revert reason can be read. */
async function deployReverts(artifact, args, from, name) {
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  try {
    await pub.call({ account: byAddress.get(from), data });
  } catch (e) {
    let all = "";
    for (let x = e, i = 0; x && i < 10; i++, x = x.cause) all += ` ${x.message ?? ""} ${x.details ?? ""} ${JSON.stringify(x.data ?? "")}`;
    assert.ok(all.includes(selector(name)), `expected ${name}, got ${all.slice(0, 300)}`);
    return;
  }
  assert.fail(`expected ${name}`);
}
const write = async (from, address, abi, functionName, args = []) => {
  const hash = await wallet(from).writeContract({ address, abi, functionName, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  assert.equal(rc.status, "success");
  return rc;
};
/**
 * Expect a revert with the named custom error. The local chain puts the revert data in its error message, so the
 * error's 4-byte selector is looked for in every message of the error chain.
 */
async function reverts(promise, name) {
  try {
    await promise;
  } catch (e) {
    const texts = [];
    let x = e;
    for (let i = 0; x && i < 10; i++, x = x.cause) texts.push(String(x.message ?? ""), String(x.details ?? ""), JSON.stringify(x.data ?? ""));
    const all = texts.join(" ");
    assert.ok(all.includes(selector(name)), `expected ${name} (${selector(name)}), got: ${all.slice(0, 300)}`);
    return;
  }
  assert.fail(`expected a revert (${name})`);
}
const selector = (name) => {
  const item = [...Agents.abi, ...Token.abi].find((x) => x.type === "error" && x.name === name);
  if (!item) throw new Error(`No error named ${name}`);
  return keccak256(toHex(`${name}(${item.inputs.map((i) => i.type).join(",")})`)).slice(0, 10);
};
const read = (functionName, args = []) => pub.readContract({ address: agents, abi: Agents.abi, functionName, args });
const bal = (who) => pub.readContract({ address: token, abi: Token.abi, functionName: "balanceOf", args: [who] });
const approve = (from, amount) => write(from, token, Token.abi, "approve", [agents, amount]);
const call = async (from, fn, args) => {
  const { request } = await pub.simulateContract({ address: agents, abi: [...Agents.abi, ...Token.abi.filter((x) => x.type === "error")], functionName: fn, args, account: byAddress.get(from) });
  const hash = await wallet(from).writeContract(request);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error("reverted");
  return rc;
};
const H = (s) => keccak256(toHex(s)); // a stand-in package hash

before(async () => {
  const accounts = (await provider.request({ method: "eth_accounts", params: [] })).map((a) => getAddress(a));
  assert.deepEqual(accounts, signers.map((a) => a.address));
  [safe, treasury, alice, bob, carol, stranger] = accounts;
  token = await deploy(Token, [], safe);
  // max fee 1,000,000; fee 10,000, half burned; platform 10%, half of it burned.
  agents = await deploy(Agents, [token, safe, treasury, N(1_000_000), N(10_000), 5000n, 1000n, 5000n], safe);
  for (const who of [alice, bob, carol]) await write(safe, token, Token.abi, "mintTo", [who, N(100_000)]);
});

test("deploys with its settings and minting closed", async () => {
  assert.equal(getAddress(await read("nomad")), token);
  assert.equal(getAddress(await read("owner")), safe);
  assert.equal(getAddress(await read("treasury")), treasury);
  assert.equal(await read("mintFee"), N(10_000));
  assert.equal(await read("maxMintFee"), N(1_000_000));
  assert.equal(await read("mintingOpen"), false);
  await approve(alice, N(10_000));
  await reverts(call(alice, "mint", ["Pip", H("pip"), "", 0n, N(10_000)]), "MintingClosed");
});

test("refuses settings over the fixed limits at deployment", async () => {
  await deployReverts(Agents, [token, safe, treasury, N(100), N(101), 0n, 0n, 0n], safe, "OverLimit");
  await deployReverts(Agents, [token, safe, treasury, N(100), N(1), 0n, 2001n, 0n], safe, "OverLimit");
  await deployReverts(Agents, [token, safe, treasury, N(100), N(1), 10001n, 0n, 0n], safe, "OverLimit");
  await deployReverts(Agents, [token, safe, "0x0000000000000000000000000000000000000000", N(100), N(1), 0n, 0n, 0n], safe, "ZeroAddress");
});

test("only the owner opens minting and changes fees, within the limits", async () => {
  await reverts(call(stranger, "setMintingOpen", [true]), "OwnableUnauthorizedAccount");
  await reverts(call(stranger, "setMintFee", [0n, 0n]), "OwnableUnauthorizedAccount");
  await reverts(call(stranger, "setPlatform", [0n, 0n]), "OwnableUnauthorizedAccount");
  await reverts(call(stranger, "setTreasury", [stranger]), "OwnableUnauthorizedAccount");
  await reverts(call(safe, "setMintFee", [N(1_000_001), 0n]), "OverLimit");
  await reverts(call(safe, "setPlatform", [2001n, 0n]), "OverLimit");
  await reverts(call(safe, "renounceOwnership", []), "CannotRenounce");
  await call(safe, "setMintingOpen", [true]);
  assert.equal(await read("mintingOpen"), true);
});

test("minting takes the fee straight from the minter: half burned, half to the treasury", async () => {
  const before = { alice: await bal(alice), burn: await bal(BURN), treasury: await bal(treasury) };
  await approve(alice, N(10_000));
  await call(alice, "mint", ["Pip", H("pip"), "https://example.com/pip.nomad", N(500), N(10_000)]);
  assert.equal(await bal(alice), before.alice - N(10_000));
  assert.equal(await bal(BURN), before.burn + N(5_000));
  assert.equal(await bal(treasury), before.treasury + N(5_000));
  assert.equal(await bal(agents), 0n, "the contract holds nothing");
  const a = await read("agent", [1n]);
  assert.equal(getAddress(a.creator), alice);
  assert.equal(a.name, "Pip");
  assert.equal(a.packageHash, H("pip"));
  assert.equal(a.price, N(500));
  assert.equal(getAddress(await read("ownerOf", [1n])), alice);
  assert.equal(await read("tokenURI", [1n]), "https://example.com/pip.nomad");
  assert.equal(await read("agentOfPackage", [H("pip")]), 1n);
  assert.equal(await read("totalMinted"), 1n);
  assert.equal(await read("totalBurned"), N(5_000));
});

test("a package is minted once, names and links have limits, and the fee cannot change under you", async () => {
  await approve(bob, N(100_000));
  await reverts(call(bob, "mint", ["Copycat", H("pip"), "", 0n, N(10_000)]), "AlreadyMinted");
  await reverts(call(bob, "mint", ["", H("b1"), "", 0n, N(10_000)]), "BadName");
  await reverts(call(bob, "mint", ["x".repeat(65), H("b1"), "", 0n, N(10_000)]), "BadName");
  await reverts(call(bob, "mint", ["Bob", H("b1"), "u".repeat(257), 0n, N(10_000)]), "BadUri");
  await reverts(call(bob, "mint", ["Bob", zeroHash, "", 0n, N(10_000)]), "BadHash");
  await reverts(call(bob, "mint", ["Bob", H("b1"), "", 0n, N(9_999)]), "FeeAboveMax");
  await approve(carol, 0n);
  await reverts(call(carol, "mint", ["Carol", H("c1"), "", 0n, N(10_000)]), "ERC20InsufficientAllowance");
});

test("a copy pays the owner, with Nomad's 10% split between burn and treasury", async () => {
  const before = { alice: await bal(alice), bob: await bal(bob), burn: await bal(BURN), treasury: await bal(treasury) };
  await approve(bob, N(500));
  await call(bob, "getCopy", [1n, N(500)]);
  assert.equal(await bal(bob), before.bob - N(500));
  assert.equal(await bal(alice), before.alice + N(450));
  assert.equal(await bal(BURN), before.burn + N(25));
  assert.equal(await bal(treasury), before.treasury + N(25));
  assert.equal(await read("hasCopy", [1n, bob]), true);
  assert.equal((await read("agent", [1n])).copies, 1n);
  assert.equal(await read("totalToCreators"), N(450));
  await reverts(call(bob, "getCopy", [1n, N(500)]), "AlreadyHasCopy");
  await reverts(call(alice, "getCopy", [1n, N(500)]), "AlreadyHasCopy");
});

test("only the agent's owner sets its price and link; a price rise cannot surprise a buyer", async () => {
  await reverts(call(bob, "setPrice", [1n, 0n]), "NotAgentOwner");
  await reverts(call(bob, "setUri", [1n, "https://evil.example"]), "NotAgentOwner");
  await call(alice, "setPrice", [1n, N(900)]);
  await approve(carol, N(900));
  await reverts(call(carol, "getCopy", [1n, N(500)]), "PriceAboveMax");
  await call(alice, "setUri", [1n, "https://example.com/pip-v2.nomad"]);
  const a = await read("agent", [1n]);
  assert.equal(a.uri, "https://example.com/pip-v2.nomad");
  assert.equal(a.packageHash, H("pip"), "the package hash never changes");
});

test("free agents cost nothing to copy; reading a missing agent reverts", async () => {
  await approve(carol, N(10_000));
  await call(carol, "mint", ["Free", H("free"), "", 0n, N(10_000)]);
  const before = await bal(bob);
  await call(bob, "getCopy", [2n, 0n]);
  assert.equal(await bal(bob), before);
  await reverts(read("agent", [99n]), "ERC721NonexistentToken");
  await reverts(call(bob, "getCopy", [99n, 0n]), "ERC721NonexistentToken");
});

test("a transferred agent's copy sales go to its new owner; the creator stays on record", async () => {
  await write(alice, agents, Agents.abi, "transferFrom", [alice, stranger, 1n]);
  const before = await bal(stranger);
  await approve(carol, N(900));
  await call(carol, "getCopy", [1n, N(900)]);
  assert.equal(await bal(stranger), before + N(810));
  assert.equal(getAddress((await read("agent", [1n])).creator), alice);
});

test("fee changes apply to the next mint; minting can be closed again", async () => {
  await call(safe, "setMintFee", [N(2_000), 10000n]); // all burned
  const burn = await bal(BURN);
  await approve(bob, N(2_000));
  await call(bob, "mint", ["Bob", H("bob"), "", 0n, N(2_000)]);
  assert.equal(await bal(BURN), burn + N(2_000));
  await call(safe, "setMintFee", [0n, 0n]);
  await call(bob, "mint", ["Bob 2", H("bob2"), "", 0n, 0n]);
  await call(safe, "setMintingOpen", [false]);
  await reverts(call(bob, "mint", ["Bob 3", H("bob3"), "", 0n, 0n]), "MintingClosed");
  // Ownership moves in two steps, so a typo cannot lose it.
  await call(safe, "transferOwnership", [treasury]);
  assert.equal(getAddress(await read("owner")), safe);
  await call(treasury, "acceptOwnership", []);
  assert.equal(getAddress(await read("owner")), treasury);
});
