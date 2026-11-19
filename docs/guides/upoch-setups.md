# Upoch setups

Upoch saves checkpoints of an AI agent's work on Robinhood Chain, so the agent can restore its last good state or roll back after a crash, a bad prompt or a bad trade. Agents reach it through Upoch Guard, a local MCP server started with `upoch mcp` from the `@upoch/guard` package. Nomad moves that MCP entry between agents. It never reads or copies Upoch's keys.

The Upoch team answered Nomad's questions about this setup and has not reviewed this guide yet. It follows Upoch's documentation (upoch.tech/docs/mcp, /docs/recovery and /docs/security-review), `@upoch/guard` 0.1.4 and the team's answers, read Nov 19, 2026.

## What moves

- The server entry, exactly as written: `upoch mcp`, or `npx @upoch/guard mcp` with its version pin.
- `UPOCH_HOME`, when the source sets it, as the path it names.

## What stays

Upoch keeps everything in one folder, `~/.upoch` by default or the folder `UPOCH_HOME` names: the owner and executor keys, the checkpoint encryption key and the storage token (in `secrets.json`), the settings, and the action journal. Nomad never reads, copies or moves that folder. The agent's workflow, guardians and checkpoints are on-chain, so they need no moving.

## Worth a look

- **One app at a time.** Upoch does not coordinate two copies of the same agent yet. Stop the agent in the app you moved it from before the new app starts it. The preview warns about this.
- **Another computer.** Restoring the Upoch folder is what carries the agent's keys. Copy it yourself, readable only by you, before the new app first starts the server. Without it, Upoch is not set up there, and a new setup registers a different agent.
- **Node.js 24.** Upoch Guard needs Node.js 24 or later on the PATH the app uses.
- **Risk Check.** Upoch's spending limits run through its SDK, not through `upoch mcp`, for now.
- **Audit.** Upoch's contracts have had an internal review but no independent audit yet, and Upoch suggests starting with low-value workflows.
- **Look-alikes.** Only `upoch mcp` and `npx @upoch/guard mcp` count as Upoch. Other commands and packages move as ordinary servers, without Upoch's notes.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
