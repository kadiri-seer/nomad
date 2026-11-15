# Hedgehood setups

Hedgehood is an options market for AI agents on Robinhood Chain: weekly calls and puts on tokenized stocks, settled in USDG, traded by an agent through a local MCP server with a session key that can trade but never withdraw. Nomad moves the Hedgehood MCP entries between agents. Keys, sessions, positions and balances stay where they are.

Hedgehood and its team have not been contacted and have not reviewed this work. This guide follows Hedgehood's documentation (github.com/0xHedgeHood/hedgehood-agent-kit) and the `@hedgehood-io/mcp` 0.5.1 package, read Nov 15, 2026.

## What moves

- The local server in each form Hedgehood documents: `npx -y @hedgehood-io/mcp` (with or without a pinned version), the global `hedgehood-mcp` command (with `--mainnet` or `--testnet` kept), and the server from Hedgehood's Claude Code plugin (`hedgehood-options@hedgehood`).
- The hosted read-only servers (`https://mcp.hedgehood.io/mcp`, `https://testnet-mcp.hedgehood.io/mcp`): their address only. They hold no keys.
- Settings that are plain values, carried as the same values: `HEDGEHOOD_CHAIN_ID` (4663 for mainnet), `HEDGEHOOD_ACCOUNT` (the owner account, a public address), `HEDGEHOOD_DRY_RUN`, `HEDGEHOOD_MAX_DEPOSIT` and the service URLs.
- The plugin's skill (`hedgehood-options`), with its reference files, on apps that have a place for skills.

## Mainnet and testnet

Hedgehood uses the testnet (46630, test funds) unless told otherwise. Mainnet (4663) settles in real USDG. The preview says which network each moved server uses:

- `HEDGEHOOD_CHAIN_ID=4663` or `--mainnet` in the entry: mainnet, named as such.
- `HEDGEHOOD_CHAIN_ID=46630` or `--testnet`: testnet. Hedgehood's Claude Code plugin sets 46630.
- Neither, or a reference: Hedgehood takes the network from `~/.hedgehood/config.json` on that computer (written by `hedgehood init --mainnet`), or uses the testnet if there is none. Set `HEDGEHOOD_CHAIN_ID=4663` on the destination for mainnet.

## What you set again

- **Key settings.** `HEDGEHOOD_SESSION_KEY_FILE`, `HEDGEHOOD_PAYER_KEY_FILE` and `HEDGEHOOD_OWNER_KEY_FILE` are carried as references, never as values; on the same computer, Hedgehood also finds the session and payer key files through `~/.hedgehood/config.json` when `hedgehood init` recorded them there. Raw keys in an entry (`HEDGEHOOD_SESSION_KEY`, `HEDGEHOOD_PAYER_KEY`, `HEDGEHOOD_OWNER_KEY`) are always written as references, even with `--include-secrets`.
- **The owner key.** It can withdraw funds and manage sessions, and Hedgehood says to keep it off shared machines. When the source gave it to the agent, the preview flags it: set it on the destination only if the agent really needs it.
- **A new computer.** The session key does not come along. Run `hedgehood init` (or `hedgehood join`) there in your own terminal, have the owner authorize the new session with a spending budget, and revoke the old session if it will no longer be used (with the owner key: `hedgehood session revoke <old session address> --send`).
- **Limits that were references.** When `HEDGEHOOD_MAX_DEPOSIT` or `HEDGEHOOD_DRY_RUN` was a reference on the source, Nomad does not write it and the preview names Hedgehood's default: 1000 USDG per deposit, and write tools that only simulate.
- **Install.** `npm install -g @hedgehood-io/mcp` for the `hedgehood-mcp` command, or Node.js 20 or later for entries that use `npx`.
- **Plugins.** On Claude Code, Nomad lists the install steps instead of copying the plugin: `/plugin marketplace add 0xHedgeHood/hedgehood-agent-kit`, then `/plugin install hedgehood-options@hedgehood`.

## What never moves

- `~/.hedgehood` and everything in it: the session, payer and owner key files and `config.json`. Nomad never reads this folder, never follows a symlink into it and never writes into it. The preview lists such paths as skipped, by path only.
- Sessions, budgets, positions, balances and anything else on chain.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
