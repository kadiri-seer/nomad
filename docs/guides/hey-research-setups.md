# HEY Research setups

HEY Research Lab is read-only research on Robinhood Chain projects: for a token or project, whether its team is still building, what it shipped and what changed, each answer linked to its public source. Agents reach it through an MCP server, hosted or local. Nomad moves those MCP entries between agents. There are no wallets or wallet keys involved.

HEY Research Lab and its team have not been contacted and have not reviewed this work. This guide follows HEY's documentation (heyresearch.xyz/developers/agents) and the `@hey-research-lab/mcp` 0.3.5 package, read Nov 16, 2026.

## What moves

- The hosted server, `https://heyresearch.xyz/mcp`, and its research profile, `https://heyresearch.xyz/mcp/research` (builder research, without market tools): their address, in each destination's own format. If an agent uses both, both move.
- The `x-hey-integration` header, which names your agent to HEY. It is a self-declared name, not a secret, and carries over as is.
- The local server in each form HEY documents: `npx -y @hey-research-lab/mcp`, with its version pin kept (for example `@0.3.5`), or the global `hey-research-mcp` command.
- The local server's settings that are plain values, carried as the same values: `HEY_MCP_PROFILE` (`research` for the research profile), `HEY_MARKET_INTEGRITY` and `HEY_API_URL`.

## What you set again

- **An API key, if you used one.** HEY works without a key; a key from heyresearch.xyz/account gives your agent its own request allowance. Nomad never copies it: it becomes a reference, and the preview says where to set it on the destination. For the hosted server the key goes in the `Authorization` header as `Bearer <your key>`; for the local server it is `HEY_API_KEY`.
- **Install.** `npm install -g @hey-research-lab/mcp` for the `hey-research-mcp` command, or Node.js 20 or later for entries that use `npx`.

## Worth a look

- **Another HEY address.** When the local server's `HEY_API_URL` points anywhere other than `https://heyresearch.xyz`, the preview warns: the API key, if one is set, is sent to that address too. Keep it only if you trust it. When `HEY_API_URL` was a reference on the source, the preview notes that without it the server reads `https://heyresearch.xyz`.
- **Look-alikes.** Only HEY's own addresses and package count as HEY: `https://heyresearch.xyz/mcp` or `/mcp/research` over https on the standard port, the exact `@hey-research-lab/mcp` package, and the `hey-research-mcp` command. Anything else moves as an ordinary server, without HEY's notes.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
