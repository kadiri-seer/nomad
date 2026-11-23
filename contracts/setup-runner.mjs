#!/usr/bin/env node
// Switches on the agent runner: makes its secret and puts it straight into Vercel (sensitive), then prints the address
// of the small wallet that pays Idlex for agents' AI jobs, to fund with a few USDG.
//
//   node contracts/setup-runner.mjs
//
// The secret is never printed or saved. Every agent's session key comes from it, so it is made once: run this again
// only with --replace, which cuts off every existing agent until its creator signs again.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { concat, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "AGENT_RUNNER_SECRET";
const replace = process.argv.includes("--replace");

function vercel(args, input) {
  const r = spawnSync("npx", ["--yes", "vercel@latest", ...args], { cwd: repo, input, encoding: "utf8", stdio: input === undefined ? "inherit" : ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const listed = vercel(["env", "ls", "production"], "");
if (!listed.ok) {
  console.error("Could not read the project's settings. Run `node contracts/deploy.mjs` first (it signs in and links Vercel), then this.");
  process.exit(1);
}
if (new RegExp(`\\b${NAME}\\b`).test(listed.out) && !replace) {
  console.log(`${NAME} is already set. Nothing changed.`);
  process.exit(0);
}

const secret = generatePrivateKey();
if (replace) vercel(["env", "rm", NAME, "production", "--yes"], "");
const added = vercel(["env", "add", NAME, "production", "--sensitive"], secret);
if (!added.ok && !vercel(["env", "add", NAME, "production"], secret).ok) {
  console.error(`Could not add ${NAME} to Vercel.`);
  process.exit(1);
}
const payer = privateKeyToAddress(keccak256(concat([secret, toHex("nomad-idlex-payer")])));
console.log(`\nSet ${NAME} in Vercel.`);
console.log(`Idlex wallet for agents' AI jobs: ${payer}`);
console.log("Send it 2 USDG on Robinhood Chain (about 1,000 jobs). Without it, Traders still run on their checks alone.");
console.log('Tell Claude "runner set": it redeploys the site.');
