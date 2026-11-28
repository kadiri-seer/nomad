# Oak setups

Oak Agent Kit is a local wallet and tools for Robinhood Chain projects, used by an agent through one MCP server. Nomad moves the Oak MCP entry between agents. The wallet, its settings and everything on chain stay where they are.

Oak is independent and is not affiliated with Robinhood. Oak and its team have not been contacted and have not reviewed this work. This guide follows Oak's documentation and the `@oakagentkit/addon` 0.3.8 package, read Nov 14, 2026, with its folder rules checked again against 0.4.4 on Nov 28, 2026.

## What moves

- The Oak MCP entry in each form Oak documents: `oak mcp` (what `oak connect` writes), `npx -y @oakagentkit/addon@<version> mcp`, and the server from Oak's Claude Code plugin (`oak@oak-agent-kit`). A pinned version is kept exactly.
- Settings in the entry that are plain values, such as `OAK_AUTO_DAILY_CAP_USD` and `OAK_CHAIN_ID`, carried as the same values.
- Settings that are references, handled as for any other server: written in the destination's own reference form, or listed as a step where the destination cannot hold them.

Each destination gets the entry Oak itself writes there:

| Destination | Entry |
| --- | --- |
| Claude Code | `"oak": { "command": "oak", "args": ["mcp"] }` in `~/.claude.json` |
| Codex | `[mcp_servers.oak]` with `command = "oak"` and `args = ["mcp"]` in `~/.codex/config.toml` |
| Cursor | `"oak"` under `mcpServers` in the project's `.cursor/mcp.json` |
| Gemini CLI | `"oak"` under `mcpServers` in `~/.gemini/settings.json` |
| Hermes | `oak` under `mcp_servers` in `~/.hermes/config.yaml` |

## What you set again

- **Install Oak** where the destination runs: `npm install -g @oakagentkit/addon` (Node.js 22.12 or later), so the `oak` command is on the PATH the app uses. Entries that use `npx` need Node.js 22.12 or later.
- **The wallet, on another computer.** If the destination runs on another computer, Oak creates a new, empty wallet there the first time it starts. To keep the same wallet, restore it there yourself, in your own terminal and never through an agent, following Oak's backup guide (`oak backup`).
- **The daily budget, if it was a reference.** When `OAK_AUTO_DAILY_CAP_USD` was a reference on the source, Nomad does not write it, and the preview says the destination uses Oak's default: 50 USD a day for automatic approvals.
- **The network, if it was a reference.** When `OAK_NETWORK` or `OAK_CHAIN_ID` is a reference, set it on the destination too; without it Oak uses Robinhood Chain mainnet.
- **Plugins.** On Claude Code, Nomad lists the install steps instead of copying the plugin: `/plugin marketplace add OakAgentKit/oak`, then `/plugin install oak@oak-agent-kit`. On other apps the plugin's server is written as an ordinary entry.
- **Approvals.** Oak asks for approval in the app before it signs (its default ask mode). Oak's documentation says apps without MCP form elicitation cannot sign in that mode, so check that the destination shows Oak's approval form before relying on it.

## What never moves

- `~/.oak` and everything in it: the encrypted wallet (`wallet.enc`), private notes (`*.gloam.enc`), the wallet journal, and Oak's settings (`config.json`, including the approval mode and the daily budget). Where no system keychain is available, Oak also keeps the key that unlocks the wallet there. Nomad never reads this folder, never follows a symlink into it and never writes into it. The preview lists such paths as skipped, by path only.
- The key in the system keychain.
- Anything on chain.
- API keys typed into an entry as plain values are carried only as references, unless you ask for secrets with `--include-secrets`. Wallet keys never travel as values, even then.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
