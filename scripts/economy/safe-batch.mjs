#!/usr/bin/env node
// Treasury actions as Safe Transaction Builder batches. Nothing is sent from here: each command writes a JSON
// file you load in the Safe's Transaction Builder (Safe app, "Transaction Builder", drag the file in), check, and
// sign there with the Safe's two approvals.
//
//   node scripts/economy/safe-batch.mjs burn <amount>                       burn $NOMAD from the treasury
//   node scripts/economy/safe-batch.mjs bounty <issue> <address> <amount>   pay a builder bounty in $NOMAD
//   node scripts/economy/safe-batch.mjs open-minting <contract>             open minting on NomadAgents
//   node scripts/economy/safe-batch.mjs close-minting <contract>            close it
//   node scripts/economy/safe-batch.mjs mint-fee <contract> <fee> <burn %>  set the mint fee and its burned share
//   node scripts/economy/safe-batch.mjs platform <contract> <share %> <burn %>   set the copy share and its burned part
//   node scripts/economy/safe-batch.mjs record-buyback --date 2026-12-01 --spent "500 USDG" --bought "1200000 $NOMAD" --tx 0x… [--burn-tx 0x…] [--note "…"]
//
// Amounts are whole $NOMAD (decimals allowed), for example 250000 or 1500.5.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { batch, recordBuyback, burnTx, bountyTx, agentsTx } from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function out(kind, b) {
  const file = resolve(process.cwd(), `safe-${kind}-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify(b, null, 2) + "\n");
  console.log(`Wrote ${file}`);
  console.log(`${b.meta.description}`);
  console.log("Load it in the Safe's Transaction Builder, check every line, and sign with two approvals. Nothing has been sent.");
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "burn":
      out("burn", batch([burnTx(rest[0])], `Burn ${rest[0]} $NOMAD from the treasury (send to the dead address).`));
      return 0;
    case "bounty":
      out(`bounty-${rest[0]}`, batch([bountyTx(rest[1], rest[2])], `Pay bounty #${rest[0]}: ${rest[2]} $NOMAD to ${rest[1]}.`));
      return 0;
    case "open-minting":
    case "close-minting":
      out(cmd, batch([agentsTx(rest[0], "setMintingOpen", [cmd === "open-minting"])], `${cmd === "open-minting" ? "Open" : "Close"} minting on NomadAgents ${rest[0]}.`));
      return 0;
    case "mint-fee":
      out("mint-fee", batch([agentsTx(rest[0], "setMintFee", [rest[1], rest[2]])], `Set the mint fee to ${rest[1]} $NOMAD, ${rest[2]}% of it burned.`));
      return 0;
    case "platform":
      out("platform", batch([agentsTx(rest[0], "setPlatform", [rest[1], rest[2]])], `Set Nomad's share of a copy's price to ${rest[1]}%, ${rest[2]}% of that burned.`));
      return 0;
    case "record-buyback": {
      const file = join(ROOT, "governance", "economy.json");
      const entry = recordBuyback(file, { date: arg(argv, "date"), spent: arg(argv, "spent"), bought: arg(argv, "bought"), tx: arg(argv, "tx"), burnTx: arg(argv, "burn-tx"), note: arg(argv, "note") });
      console.log(`Added the buyback of ${entry.date} to governance/economy.json. Commit and push it; the economy page reads it from the repo.`);
      return 0;
    }
    default:
      console.log("Commands: burn, bounty, open-minting, close-minting, mint-fee, platform, record-buyback. See the top of this file.");
      return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("safe-batch.mjs")) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`Nothing was written: ${e.message}`);
    process.exit(1);
  }
}
