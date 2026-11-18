# Ostra setups

Ostra gives an AI agent its own vault of USDG on Robinhood Chain, guarded by post-quantum one-time keys, with tools to pay for services, work and hire on Ostrapad, and earn. Agents reach it through Ostra's MCP server on their own computer, or through Ostra's hosted connector. Nomad moves those MCP entries between agents. The vault's seed never moves.

Ostra's team asked Nomad to add its server and has not yet reviewed this work. This guide follows Ostra's documentation (docs.ostraagent.xyz/keys and /claude) and the `@ostraagent/mcp` 0.1.24 package, read Nov 18, 2026.

## What moves

- The local server in each form Ostra documents: `npx -y @ostraagent/mcp`, with its version pin kept (for example `@0.1.24`), or the global `ostra-mcp` command, in each destination's own format.
- Its plain settings, as the same values: `OSTRA_HOME`, service addresses, and `off` wherever a service or RPC is turned off.
- The hosted connector, `https://mcp.ostraagent.xyz/mcp`: its address only.

## What never moves

- **The seed.** `master.key` in `OSTRA_HOME` (by default `~/.ostra`) holds every vault of the agent, next to `fee-payer.key` and the one-time key records in `wots/`. Nomad never reads that folder, never follows a link into it and never writes into it, whatever options are set.
- **Seed backups.** A file made by `backup export` (such as `ostra-seed-backup.json`) is never read or copied, and a backup pasted into notes or other text is removed.
- **RPC keys.** `OSTRA_RPC_URL`, `OSTRA_LOGS_RPC_URL`, `OSTRA_ETH_RPC_URL` and similar can carry a provider key, so anything but a public endpoint becomes a reference you set on the destination. `OSTRA_RPC_URL_FILE` moves as its path; the file it names does not.

## Moving

- **One place at a time.** Ostra runs one seed in one place at a time. Before the moved agent starts, remove Ostra from the app it came from, or turn it off there. The preview says so.
- **To another computer.** Without the seed, the new computer starts a new, empty vault. Stop Ostra on the old computer and run `npx -y @ostraagent/mcp backup export <file>` there (with the same `OSTRA_HOME`, if one is set). On the new computer, run `npx -y @ostraagent/mcp backup import <file>` before the destination app first starts Ostra: the import refuses a folder that already holds a seed. Withdraw from Ostra's older shielded-pool vaults first, or copy the `shield/` and `unshield/` folders with the file. Keep the file and its passphrase apart.
- **The hosted connector.** The vault's owner seed stays in the owner's browser and its agent key with Ostra's gateway. Sign in to the connector again on the destination.
- **Install.** Node.js 22 or later for `npx`, or `npm install -g @ostraagent/mcp` for the `ostra-mcp` command. A prover set with `OSTRA_PROVER` is a program Nomad does not copy.

## Worth a look

- **Another deployment.** `OSTRA_DEPLOYMENT` or `OSTRA_SWAP_DEPLOYMENT` points the vault at another set of contracts. The preview warns: keep it only if you trust it.
- **Other service addresses.** When a relayer, keeper, aggregator, AI, Raeto or Ostrapad address is not Ostra's own (and not `off`), the preview warns.
- **Look-alikes.** Only Ostra's own package, command and connector count as Ostra: the exact `@ostraagent/mcp` package, the `ostra-mcp` command, and `https://mcp.ostraagent.xyz/mcp` over https on the standard port. Anything else moves as an ordinary server, without Ostra's notes.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
