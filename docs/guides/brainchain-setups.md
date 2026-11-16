# BrainChain setups

BrainChain verifies AI agent work and settles payments for it on Robinhood Chain and Base. An agent posts a scoped task through BrainChain's local MCP server (`brainchain-mcp`), and pays 1 USDG or 1 USDC only if the result is accepted. Nomad moves the BrainChain MCP entries and the BrainChain skills between agents. Keys, tasks, bonds and approvals stay where they are.

This guide follows BrainChain's public documentation (docs.usebrainchain.com/agents) and repositories (github.com/usebrainchain/brainchain-mcp and github.com/usebrainchain/brainchain-worker), with `brainchain-mcp` 0.9.3, read Nov 15, 2026.

## What moves

- The server in each form BrainChain documents: `npx -y brainchain-mcp` (with or without a pinned version), as `claude mcp add` writes it, as the repository's `mcp.json` has it, and as `openclaw mcp set` registers it; and the global `brainchain-mcp` command.
- Settings that are plain values, carried as the same values: `BRAINCHAIN_NETWORK`, `BRAINCHAIN_PAY_ON`, the limits `BRAINCHAIN_MAX_PRICE_UNITS`, `BRAINCHAIN_BUDGET_UNITS`, `BRAINCHAIN_DAILY_UNITS` and `BRAINCHAIN_MAX_BOND_UNITS`, and `BRAINCHAIN_STATE_DIR`.
- The `brainchain` and `brainchain-worker` skills, on apps that have a place for skills. Both are written for OpenClaw, and the preview says what that means on another app.

## Mainnet and where it pays

BrainChain uses mainnet unless `BRAINCHAIN_NETWORK=testnet`, and pays in USDG on Robinhood Chain unless `BRAINCHAIN_PAY_ON=base` (USDC on Base). The preview says which one each moved server uses, with its limits:

- Mainnet: shown as a warning, for example "pays on Robinhood Chain mainnet in real USDG: up to 1 USDG per task and 10 USDG per run".
- Testnet: shown as a note, with test tokens.
- A network that was a variable on the source: shown as a warning, since BrainChain then uses mainnet unless it is set to testnet on the destination.
- No daily cap: shown as a warning. Without `BRAINCHAIN_DAILY_UNITS`, BrainChain limits only each run, and that budget starts over whenever the app restarts the server. Amounts are in units of 0.000001: `5000000` is 5 USDG or USDC.

## What you set again

- **The wallet key.** `BRAINCHAIN_PAYER_KEY_FILE` and `BRAINCHAIN_PAYER_KEY` are carried as references, never as values, even with `--include-secrets`. BrainChain recommends the key file (owner-only, holding only that key) over a raw key in the app's settings, and the preview says so when the source gave the key directly. When the source set both, Nomad writes neither, as the server refuses both.
- **A key that was optional on the source** (Hermes) may be left out on an app that refuses unset references. The preview then says plainly that the server starts and reads, but cannot post or bond tasks until the key is set.
- **A new computer.** The key file does not come along. Create it there yourself, for a wallet that holds only what the agent may spend.
- **The one-time approval.** Paying in USDG on Robinhood Chain needs a Permit2 approval once per wallet: `BRAINCHAIN_PAYER_KEY_FILE=<key file> npx -y brainchain-mcp@0.9.3 approve`. The preview lists it, and the `wallet` command that checks a key is ready to pay. Paying on Base needs no approval.
- **Limits that were references.** When a limit was a variable on the source, Nomad does not write it and the preview names BrainChain's default: 10 per run, no daily cap, or 10 USDG per bond.
- **OpenClaw.** Nothing with `${...}` in it is written into `openclaw.json`, so each key setting becomes an `openclaw config set mcp.servers.brainchain.env.<VAR> <value>` step. The `brainchain-worker` skill reads its key through OpenClaw's secrets settings, which Nomad does not copy: redo the skill's operator setup on the destination, then start the worker again.
- **Install.** Node.js 22 or later for entries that use `npx`, or `npm install -g brainchain-mcp` for the `brainchain-mcp` command.

## What never moves

- `~/.brainchain` and everything in it: the payer and worker key files and the daily spending record. Nomad never reads this folder, never follows a link into it and never writes into it. The same holds for the worker's state in `~/.config/brainchain-worker`.
- The worker itself (`brainchain-worker run`), which is a program you run, not part of an agent's setup.
- Tasks, bonds, stakes, the Permit2 approval and anything else on chain.
- A BrainChain server installed as a Cursor plugin, which Nomad does not read: install the plugin again in Cursor.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
