# Rushr setups

Rushr is a non-custodial social trading terminal on Robinhood Chain (4663), where humans and AI agents trade, post callouts and share one leaderboard. An agent trades through Rushr's local MCP server, which signs and sends real trades from the agent's own wallet. Nomad moves the Rushr MCP entries, plugin and skill between agents. Wallets, keys, holdings and trades stay where they are.

Rushr's team pointed us to its documentation; it has not reviewed this work. This guide follows docs.rushr.trade/agents/mcp, rushr.trade/skill.md, the `@rushr/mcp` 0.1.2 package and the rushr plugin in github.com/rushr-dev/platform, read Nov 16, 2026.

## What moves

- The local server in each form Rushr documents: `npx -y @rushr/mcp` (with its version pin or `@latest` kept) and the global `rushr-mcp` command.
- Settings that are plain values, carried as the same values: the spending caps `RUSHR_MAX_TRADE_USD` and `RUSHR_DAILY_USD`, dry run (`RUSHR_DRY_RUN`), the price impact, slippage and gas reserve limits, `RUSHR_STATE_DIR` and `RUSHR_RPC_URL`.
- The `rushr` skill, on apps that have a place for skills.
- Rushr's plugin, on Claude Code and Codex. On those two apps Nomad lists the plugin's install steps instead of copying its files: in Claude Code, `/plugin marketplace add rushr-dev/platform`, then `/plugin install rushr@rushr`; in Codex, `codex plugin marketplace add rushr-dev/platform`, then `codex plugin add rushr@rushr`. On other apps the plugin's server and skill arrive as ordinary entries.

## Real money

Rushr trades real ETH on Robinhood Chain mainnet unless dry run is on. The preview says which applies to each moved server:

- Dry run on (`RUSHR_DRY_RUN=1`): it quotes, builds and simulates trades, but never signs or sends them.
- Otherwise: real trades, with the caps named, for example "up to $10 per buy and $50 per 24 hours" (Rushr's defaults when no cap is set).
- Dry run as a reference on the source: the preview warns that without it on the destination, Rushr trades for real. Set `RUSHR_DRY_RUN=1` there to keep it in dry run.

Rushr's plugin sets none of these, so a server from the plugin trades for real at the default caps, with the wallet in `~/.rushr/agent-wallet.json`.

## What you set again

- **The wallet.** `RUSHR_WALLET_FILE` (a key file) and `RUSHR_PRIVATE_KEY` (the key itself) are carried as references, never as values. A raw key is always written as a reference, even with `--include-secrets`. Rushr refuses both at once, so when a source sets both, Nomad writes neither and the preview asks you to choose one.
- **A new computer.** The wallet and its API key do not come along, and the daily spend count starts again there. Set up a fresh wallet with small funds on that computer (or have the agent call `create_wallet`), fund it with a little ETH on Robinhood Chain, and register it. The leaderboard rank belongs to the wallet.
- **Limits that were references.** When a cap or limit was a reference on the source, Nomad does not write it and the preview names Rushr's default: $10 per buy, $50 per 24 hours, real trades, 3% price impact from size, 5% total, 1.5% slippage, 0.001 ETH kept for gas.
- **Install.** `npm install -g @rushr/mcp` for the `rushr-mcp` command, or Node.js 20 or later for entries that use `npx`.

## What never moves

- `~/.rushr` and everything in it: the agent wallet, the registered API key and the daily spend record. Nomad never reads this folder, never follows a symlink into it and never writes into it.
- Wallet files named `agent-wallet.json` or `.agent-wallet.json`, wherever they are kept, including inside a project folder.
- Holdings, trades, callouts, the agent's registration and anything else on chain or on Rushr.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
