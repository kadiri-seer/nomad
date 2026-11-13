# Priors setups

We are exploring Priors setups: moving the Priors MCP servers and Hermes plugin settings between agents, with keys and limits shown as things you set again.

Priors is a credit service for agents on Robinhood Chain. A Priors setup is configuration: one or two MCP servers, sometimes a plugin, and a few `PRIORS_*` variables. Nomad moves the configuration. The wallet, its key and everything on chain stay where they are.

Nothing on this page has been run against a real Priors install yet. See [STATUS](../STATUS.md) for what has and has not been checked.

## What moves

- The local wallet server (`@priors/mcp`, often named `priors-wallet`): command, arguments, and its variables as references or literal values.
- The hosted read-only server (`https://mcp.priors.trade/mcp`): its address only. It is a remote server run by a third party.
- Servers and skills from an enabled Claude Code plugin (`priors@priors-agents`) or Hermes plugin (`priors`), written as ordinary entries on platforms that are not the plugin's own.
- Safety limits that were literal values (`PRIORS_PAY_HOSTS`, `PRIORS_MAX_SPEND_DAY_USD`, `PRIORS_MAX_BORROW_DAY_USD` and the others) are carried as the same values.
- `PRIORS_AGENT_ID`, the agent's ERC-8004 id, which is not a secret.

How references are written on each platform:

| Destination | Reference form |
| --- | --- |
| Claude Code | `${NAME}`; `${PRIORS_AGENT_ID:-}` where an empty value is accepted |
| Codex | `env_vars = ["NAME"]`: Codex forwards the variable from your shell |
| Hermes | `${NAME}` in config.yaml, resolved from `~/.hermes/.env` |
| Cursor | `${env:NAME}` |
| Gemini CLI | `${NAME}` (not verified) |

## What you set again

- `PRIORS_KEY` or `PRIORS_KEY_FILE`. Create the key file on the new machine, owner-only (`chmod 600`), for a dedicated wallet, and set the variable. Set one of the two: Priors refuses both. When a source listed both, Nomad writes neither and asks you to choose.
- Any key file named in launch arguments, such as `~/.config/priors/agent.key`. Nomad copies the argument, not the file.
- Safety limits that were references on the source. Nomad cannot see their values, so it does not write them, and the preview warns that Priors' defaults are looser: any public https host, no daily caps.
- Daily spend and borrow counters start again on the new platform, because Priors counts them per state folder. Give every client that uses the same key the same limits.
- Approvals. Hermes marks the Priors servers `untrusted` (it asks before every call that is not read-only). That setting does not move; set the destination to ask before `priors-wallet` tools.
- Plugins. On the plugin's own platform, Nomad lists the install steps instead of copying the plugin's files: `/plugin marketplace add priors-agents/priors` and `/plugin install priors@priors-agents` for Claude Code, `hermes plugins install priors` and `hermes plugins enable priors` for Hermes.
- If the server command is `priors-mcp`, install it yourself: `npm install -g @priors/mcp@<version you trust>`, with Node.js 20.10 or later.

## What never moves

- Wallet keys, key files and recovery phrases. Folders that can hold them (`~/.config/priors/`, `~/.local/state/priors-mcp/`, `~/.priors/`, `.agent001/`) are never read, never followed through a symlink and never written. The preview lists them as skipped, by path only.
- `~/.hermes/.env` and any other `.env` file.
- On-chain state: the ERC-8004 identity, the credit line, open loans, Autopay enrolment and the declared agent wallet stay with the wallet. Moving the agent does not move or repay them.
- Disabled servers and plugins that are not enabled: they are not switched on anywhere.
- Plugin code. Native Hermes plugins are listed by name only.

## Not covered

Claude Desktop (`claude_desktop_config.json`), Cline settings and the AgentKit provider (a code library, not a configuration format).
