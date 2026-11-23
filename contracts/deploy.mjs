#!/usr/bin/env node
// Deploys Nomad's account contracts to Robinhood Chain from the maintainer's own computer, and switches the site on.
//
//   node contracts/deploy.mjs
//
// 1. Makes a fresh deployer wallet (kept in ~/.nomad-deploy, outside the repo) and waits for a little ETH on it.
// 2. Deploys NomadAgents (minting starts closed) and NomadPaymaster, both owned by Nomad's Safe.
// 3. Makes the paymaster's signer key and sends it, with the other settings, straight to Vercel (vercel env add).
//    The key is never printed and is removed from disk once Vercel has it.
// 4. Funds the paymaster's deposit, then sends what is left back to the Safe.
// Safe to run again: it picks up where it stopped. Nothing here needs a browser wallet.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, formatEther, http, parseEther, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// Fixed for Nomad on Robinhood Chain.
const RPC = flag("--rpc") ?? "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = Number(flag("--chain-id") ?? 4663);
const STATE_DIR = flag("--state") ?? join(homedir(), ".nomad-deploy");
const NO_VERCEL = args.includes("--no-vercel");
const SAFE = "0xe4862B7605f0CD66796F5d1A9cC936462642b515";
const NOMAD = "0x14c0a77e792f6c9818888630e95c50cf3b48c979";
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const PRIVY_APP_ID = "cmwtdqajs009n0gjjjrzvq7ac";
const AGENTS_ARGS = [NOMAD, SAFE, SAFE, parseUnits("10000000", 18), parseUnits("142000", 18), 5000n, 1000n, 5000n];
const MAX_COST_PER_OP = parseEther("0.0005");
const DEPOSIT = parseEther("0.005");
const NEED = parseEther("0.0055"); // deposit plus both deployments, with room to spare

const chain = defineChain({ id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const art = (name) => JSON.parse(readFileSync(join(here, "artifacts", `${name}.json`), "utf8"));

const statePath = join(STATE_DIR, "state.json");
const load = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {});
const save = (s) => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath, JSON.stringify(s, null, 2), { mode: 0o600 });
};
const say = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const explorer = (kind, v) => `https://robinhoodchain.blockscout.com/${kind}/${v}`;

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? question : "");
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(a.trim());
    });
  });
}

function vercel(cmdArgs, input) {
  const r = spawnSync("npx", ["--yes", "vercel@latest", ...cmdArgs], { cwd: repo, input, stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
  return r.status === 0;
}

async function main() {
  const s = load();
  if ((await pub.getChainId()) !== CHAIN_ID) throw new Error(`The RPC is not chain ${CHAIN_ID}.`);

  // 1. Deployer wallet.
  if (!s.deployerKey) {
    s.deployerKey = generatePrivateKey();
    save(s);
  }
  const deployer = privateKeyToAccount(s.deployerKey);
  const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });
  say(`Deployer wallet: ${deployer.address}`);
  let bal = await pub.getBalance({ address: deployer.address });
  const need = s.deposited ? 0n : s.agents && s.paymaster ? DEPOSIT + parseEther("0.0002") : NEED;
  if (bal < need) {
    say(`\nSend ${formatEther(need - bal)} ETH on Robinhood Chain to ${deployer.address}`);
    say("(from your Safe, an exchange or any wallet). Waiting for it to arrive; this window can stay open.");
    while (bal < need) {
      await sleep(10_000);
      bal = await pub.getBalance({ address: deployer.address });
    }
  }
  say(`Balance: ${formatEther(bal)} ETH`);

  const deploy = async (name, ctorArgs) => {
    const a = art(name);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args: ctorArgs });
    say(`${name}: sent ${hash}, waiting`);
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} did not deploy: ${explorer("tx", hash)}`);
    say(`${name}: ${r.contractAddress}`);
    return r.contractAddress;
  };

  // 2. Contracts. NomadAgents starts with minting closed; the Safe opens it.
  if (!s.agents) {
    s.agents = await deploy("NomadAgents", AGENTS_ARGS);
    save(s);
  }
  if (!s.signerKey && !s.signerAddress) {
    s.signerKey = generatePrivateKey();
    s.signerAddress = privateKeyToAddress(s.signerKey);
    save(s);
  }
  if (!s.paymaster) {
    s.paymaster = await deploy("NomadPaymaster", [ENTRY_POINT, s.signerAddress, SAFE, MAX_COST_PER_OP, SAFE]);
    save(s);
  }

  // 3. Vercel settings, production. Secrets go through stdin and are marked sensitive.
  if (!NO_VERCEL) {
    s.env ??= {};
    say("\nSetting the site's settings in Vercel.");
    if (!vercel(["whoami"], "")) {
      say("Sign in to Vercel (a browser window opens):");
      if (!vercel(["login"])) throw new Error("Vercel sign-in did not finish. Run this script again.");
    }
    if (!existsSync(join(repo, ".vercel", "project.json"))) {
      say("Pick Nomad's website project when asked:");
      if (!vercel(["link"])) throw new Error("Linking the Vercel project did not finish. Run this script again.");
    }
    const values = {
      NEXT_PUBLIC_AGENTS_CONTRACT: [s.agents, false],
      NEXT_PUBLIC_NOMAD_PAYMASTER: [s.paymaster, false],
      NEXT_PUBLIC_PRIVY_APP_ID: [PRIVY_APP_ID, false],
      NOMAD_PAYMASTER_SIGNER_KEY: [s.signerKey, true],
      ALCHEMY_RPC_URL: [null, true]
    };
    for (const [name, [given, secret]] of Object.entries(values)) {
      if (s.env[name]) continue;
      let value = given;
      if (name === "ALCHEMY_RPC_URL") {
        value = await ask("Paste the Robinhood Chain endpoint from dashboard.alchemy.com (hidden): ", true);
        if (!/^https:\/\/robinhood-mainnet\.g\.alchemy\.com\/v2\/\S+$/.test(value)) throw new Error("That is not an Alchemy Robinhood Chain endpoint. Run this script again.");
      }
      if (!value) throw new Error(`No value for ${name}.`);
      vercel(["env", "rm", name, "production", "--yes"], "");
      const ok = vercel(["env", "add", name, "production", ...(secret ? ["--sensitive"] : [])], value) || vercel(["env", "add", name, "production"], value);
      if (!ok) throw new Error(`Could not set ${name} in Vercel. Run this script again.`);
      s.env[name] = true;
      if (name === "NOMAD_PAYMASTER_SIGNER_KEY") delete s.signerKey; // Vercel has it; nothing else keeps it
      save(s);
      say(`Set ${name}`);
    }
  }

  // 4. Deposit, once the signer key is safely in Vercel.
  if (!s.deposited && (NO_VERCEL || s.env?.NOMAD_PAYMASTER_SIGNER_KEY)) {
    const pm = art("NomadPaymaster");
    const hash = await wallet.sendTransaction({ to: s.paymaster, data: encodeFunctionData({ abi: pm.abi, functionName: "deposit" }), value: DEPOSIT });
    say(`Deposit: sent ${hash}, waiting`);
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success") throw new Error(`The deposit failed: ${explorer("tx", hash)}`);
    s.deposited = true;
    save(s);
  }

  // 5. Send what is left on the deployer back to the Safe.
  if (s.deposited && (NO_VERCEL || Object.keys(s.env ?? {}).length === 5)) {
    const left = await pub.getBalance({ address: deployer.address });
    const gasPrice = ((await pub.getGasPrice()) * 12n) / 10n;
    const gas = ((await pub.estimateGas({ account: deployer, to: SAFE, value: 1n })) * 12n) / 10n;
    if (left > gas * gasPrice * 3n) {
      const hash = await wallet.sendTransaction({ to: SAFE, value: left - gas * gasPrice, gas, gasPrice });
      await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      say(`Sent the leftover ${formatEther(left - gas * gasPrice)} ETH back to the Safe.`);
    }
  }

  const deposit = await pub.readContract({ address: s.paymaster, abi: art("NomadPaymaster").abi, functionName: "getDeposit" });
  say("\nDone.");
  say(`NomadAgents:    ${s.agents}  (minting closed until the Safe opens it)`);
  say(`NomadPaymaster: ${s.paymaster}  (deposit ${formatEther(deposit)} ETH)`);
  say(`Deployer left:  ${formatEther(await pub.getBalance({ address: deployer.address }))} ETH`);
  say("Tell Claude \"deployed\": it redeploys the site and runs the live test.");
}

main().catch((e) => {
  console.error(`\nStopped: ${e.shortMessage ?? e.message}`);
  process.exit(1);
});
