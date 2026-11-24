#!/usr/bin/env node
// Sets the agent mint fee to a dollar amount of $NOMAD at Stoa's live price, with a dollar amount of it burned.
//
//   node set-fee.mjs                      $5 fee, $1 burned, $4 to the treasury
//   node set-fee.mjs --usd 5 --burn-usd 1
//   node set-fee.mjs --dry                shows what it would set, asks for nothing
//
// It asks for the contract owner's private key (the treasury wallet), hidden. The key is used once to sign and is
// never saved, printed or sent anywhere but the signature. It checks the key is the owner and asks before sending.
import { createInterface } from "node:readline";
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const AGENTS = "0x3F122eA365e4b6B576D859fDf70B17080290bB4f";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NOMAD = "0x14c0a77e792f6c9818888630e95c50cf3b48c979";
const usd = Number(flag("--usd") ?? 5);
const burnUsd = Number(flag("--burn-usd") ?? 1);
const dry = process.argv.includes("--dry");

const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const abi = parseAbi([
  "function mintFee() view returns (uint256)",
  "function mintBurnBps() view returns (uint256)",
  "function maxMintFee() view returns (uint256)",
  "function owner() view returns (address)",
  "function setMintFee(uint256 fee, uint256 burnBps)"
]);
const nomad = (v) => Math.floor(Number(formatUnits(v, 18))).toLocaleString("en-US");

function ask(question, hidden = false) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (hidden) rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? question : "");
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(a.trim());
    });
  });
}

async function main() {
  if (!(usd > 0) || !(burnUsd >= 0) || burnUsd > usd) throw new Error("--usd must be above 0, and --burn-usd between 0 and --usd.");
  const q = await fetch(`https://stoadex.com/api/v1/quote?chain=robinhood&sellToken=${USDG}&buyToken=${NOMAD}&amount=${Math.round(usd * 1e6)}`).then((r) => r.json());
  if (!q.amountOut) throw new Error(`Stoa gave no price right now: ${q.error ?? "no answer"}. Try again in a minute.`);
  // Whole $NOMAD, as the fee is shown in whole tokens.
  const fee = (BigInt(q.amountOut) / 10n ** 18n) * 10n ** 18n;
  const burnBps = BigInt(Math.round((burnUsd / usd) * 10_000));
  const burned = (fee * burnBps) / 10_000n;
  const [current, currentBps, max, owner] = await Promise.all(["mintFee", "mintBurnBps", "maxMintFee", "owner"].map((f) => pub.readContract({ address: AGENTS, abi, functionName: f })));
  if (fee > max) throw new Error(`$${usd} is ${nomad(fee)} $NOMAD, above the contract's most (${nomad(max)}).`);

  console.log(`\nNow:  ${nomad(current)} $NOMAD per agent, ${Number(currentBps) / 100}% burned`);
  console.log(`New:  ${nomad(fee)} $NOMAD per agent ($${usd} at Stoa's price now)`);
  console.log(`      ${nomad(burned)} burned (about $${burnUsd}), ${nomad(fee - burned)} to the treasury (about $${usd - burnUsd})`);
  console.log(`Contract owner: ${owner}`);
  if (dry) return console.log("\nDry run: nothing was sent.");

  const key = await ask("\nPaste the owner wallet's private key (hidden), then press Enter: ", true);
  let account;
  try {
    account = privateKeyToAccount(/^0x/.test(key) ? key : `0x${key}`);
  } catch {
    // Never echo what was typed.
    throw new Error("That is not a private key (64 hex characters). Nothing was sent.");
  }
  if (account.address.toLowerCase() !== owner.toLowerCase()) throw new Error(`That key is for ${account.address}, not the contract owner. Nothing was sent.`);
  if ((await ask(`Type yes to set the fee to ${nomad(fee)} $NOMAD with ${Number(burnBps) / 100}% burned: `)).toLowerCase() !== "yes") return console.log("Stopped. Nothing was sent.");

  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const { request } = await pub.simulateContract({ account, address: AGENTS, abi, functionName: "setMintFee", args: [fee, burnBps] });
  const hash = await wallet.writeContract(request);
  console.log(`Sent: https://robinhoodchain.blockscout.com/tx/${hash}`);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(r.status === "success" ? `Done. Creating an agent now costs ${nomad(fee)} $NOMAD.` : "The transaction failed. The fee did not change.");
}

main().catch((e) => {
  console.error(`\n${e.shortMessage ?? e.message}`);
  process.exit(1);
});
