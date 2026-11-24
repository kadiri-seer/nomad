// NomadFeeKeeper on a local test chain (ganache, in process): it takes over NomadAgents, its keeper can only move the
// mint fee within bounds, by at most 25%, at most every 5 minutes, with the owner's burn share; everything else, and
// taking NomadAgents back, stays with the owner.
//   node build.mjs && node --test test/
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ganache from "ganache";
import { createPublicClient, createWalletClient, custom, getAddress, parseUnits, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const art = (n) => JSON.parse(readFileSync(join(here, "..", "artifacts", `${n}.json`), "utf8"));
const Agents = art("NomadAgents");
const Keeper = art("NomadFeeKeeper");
const Token = art("TestToken");
const BURN = "0x000000000000000000000000000000000000dEaD";
const N = (v) => parseUnits(String(v), 18);

const KEYS = Array.from({ length: 5 }, (_, i) => keccak256(toHex(`nomad-fee-keeper-test-${i}`)));
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
const errors = [...Agents.abi, ...Keeper.abi, ...Token.abi].filter((x) => x.type === "error");

let owner, treasury, bot, alice, stranger;
let token, agents, keeper;

async function deploy(artifact, args, from) {
  const hash = await wallet(from).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  assert.equal(rc.status, "success");
  return getAddress(rc.contractAddress);
}
const selector = (name) => {
  const item = errors.find((x) => x.name === name);
  return keccak256(toHex(`${name}(${item.inputs.map((i) => i.type).join(",")})`)).slice(0, 10);
};
const send = async (from, address, abi, functionName, args = []) => {
  const { request } = await pub.simulateContract({ address, abi: [...abi, ...errors], functionName, args, account: byAddress.get(from) });
  const rc = await pub.waitForTransactionReceipt({ hash: await wallet(from).writeContract(request) });
  if (rc.status !== "success") throw new Error("reverted");
  return rc;
};
async function reverts(promise, name) {
  try {
    await promise;
  } catch (e) {
    let all = "";
    for (let x = e, i = 0; x && i < 10; i++, x = x.cause) all += ` ${x.message ?? ""} ${x.details ?? ""} ${JSON.stringify(x.data ?? "")}`;
    assert.ok(all.includes(selector(name)) || all.includes(name), `expected ${name}, got ${all.slice(0, 300)}`);
    return;
  }
  assert.fail(`expected ${name}`);
}
const readA = (fn, args = []) => pub.readContract({ address: agents, abi: Agents.abi, functionName: fn, args });
const readK = (fn) => pub.readContract({ address: keeper, abi: Keeper.abi, functionName: fn });
const later = async (seconds) => {
  await provider.request({ method: "evm_increaseTime", params: [seconds] });
  await provider.request({ method: "evm_mine", params: [] });
};

before(async () => {
  const accounts = (await provider.request({ method: "eth_accounts", params: [] })).map((a) => getAddress(a));
  [owner, treasury, bot, alice, stranger] = accounts;
  token = await deploy(Token, [], owner);
  // Like the live contract: max 10,000,000, fee 142,000, half burned, minting open.
  agents = await deploy(Agents, [token, owner, treasury, N(10_000_000), N(142_000), 5000n, 1000n, 5000n], owner);
  await send(owner, agents, Agents.abi, "setMintingOpen", [true]);
  // The keeper: $1 of $5 burned (20%), fee between 16,000 and 400,000.
  keeper = await deploy(Keeper, [agents, owner, bot, 2000n, N(16_000), N(400_000)], owner);
});

test("takes over NomadAgents only when its owner hands it over", async () => {
  await reverts(send(bot, keeper, Keeper.abi, "acceptAgentsOwnership"), "OwnableUnauthorizedAccount");
  await send(owner, agents, Agents.abi, "transferOwnership", [keeper]);
  await reverts(send(stranger, keeper, Keeper.abi, "acceptAgentsOwnership"), "NotKeeper");
  await send(bot, keeper, Keeper.abi, "acceptAgentsOwnership");
  assert.equal(getAddress(await readA("owner")), keeper);
});

test("the keeper moves the fee within its limits, with the owner's burn share", async () => {
  // 142,000 -> 110,000 is 22.5% down: allowed, and the burn share becomes 20%.
  await send(bot, keeper, Keeper.abi, "updateFee", [N(110_000)]);
  assert.equal(await readA("mintFee"), N(110_000));
  assert.equal(await readA("mintBurnBps"), 2000n);
  await reverts(send(bot, keeper, Keeper.abi, "updateFee", [N(100_000)]), "TooSoon");
  await later(301);
  await reverts(send(bot, keeper, Keeper.abi, "updateFee", [N(81_000)]), "StepTooLarge"); // 26% down
  await send(bot, keeper, Keeper.abi, "updateFee", [N(84_000)]);
  await later(301);
  await reverts(send(bot, keeper, Keeper.abi, "updateFee", [N(15_000)]), "OutOfBounds");
  await reverts(send(stranger, keeper, Keeper.abi, "updateFee", [N(84_000)]), "NotKeeper");
});

test("a mint then pays the new fee: 20% burned, the rest to the treasury", async () => {
  await send(owner, token, Token.abi, "mintTo", [alice, N(100_000)]);
  await send(alice, token, Token.abi, "approve", [agents, N(84_000)]);
  const burnBefore = await pub.readContract({ address: token, abi: Token.abi, functionName: "balanceOf", args: [BURN] });
  await send(alice, agents, Agents.abi, "mint", ["Anne", keccak256(toHex("anne")), "", 0n, N(84_000)]);
  const burned = (await pub.readContract({ address: token, abi: Token.abi, functionName: "balanceOf", args: [BURN] })) - burnBefore;
  assert.equal(burned, N(16_800));
  assert.equal(await pub.readContract({ address: token, abi: Token.abi, functionName: "balanceOf", args: [treasury] }), N(67_200));
});

test("everything else stays with the owner, who can take NomadAgents back", async () => {
  for (const [fn, args] of [["setTreasury", [stranger]], ["setMintingOpen", [false]], ["setPlatform", [0n, 0n]], ["setBounds", [N(1), N(2), 0n]], ["setKeeper", [stranger]], ["setFee", [N(1), 0n]], ["returnAgents", [stranger]], ["transferOwnership", [stranger]]]) {
    await reverts(send(bot, keeper, Keeper.abi, fn, args), "NotOwner");
  }
  await send(owner, keeper, Keeper.abi, "setMintingOpen", [false]);
  assert.equal(await readA("mintingOpen"), false);
  await send(owner, keeper, Keeper.abi, "setMintingOpen", [true]);
  await reverts(send(owner, keeper, Keeper.abi, "setBounds", [N(1), N(20_000_000), 2000n]), "BadSettings"); // above the contract's most
  await send(owner, keeper, Keeper.abi, "setKeeper", ["0x0000000000000000000000000000000000000000"]);
  await reverts(send(bot, keeper, Keeper.abi, "updateFee", [N(84_000)]), "NotKeeper");
  await send(owner, keeper, Keeper.abi, "returnAgents", [owner]);
  await send(owner, agents, Agents.abi, "acceptOwnership");
  assert.equal(getAddress(await readA("owner")), owner);
  assert.equal(getAddress(await readK("owner")), owner);
});
