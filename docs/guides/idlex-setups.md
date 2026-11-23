# Idlex setups

Idlex runs AI jobs (text with Qwen2.5, images with Stable Diffusion 1.5, embeddings) on community GPUs. Agents reach it through `idlex-mcp`, a local MCP server started with `node /path/to/idlex-mcp/src/server.ts`. It pays for each job in USDG on Robinhood Chain over x402, from the agent's own wallet, and only once the job is verified. Nomad moves that MCP entry between agents. It never copies the wallet key.

This follows Idlex's README and its agents page (idlex.network/agents) and the code of `idlex-mcp` 0.1.0, read Nov 23, 2026. The Idlex team has not reviewed this work yet.

## What moves

- The server entry, exactly as written: `node` and the path to `src/server.ts`.
- The spend limits, when the source writes them as values: `IDLEX_MAX_JOB_USDG` (the most for one job) and `IDLEX_BUDGET_USDG` (the most in one session).
- `IDLEX_API` and `IDLEX_RPC`, when set.

## What stays

- `IDLEX_AGENT_KEY`, the agent wallet's key. Keys are references only: set it again on the destination, to the same wallet's key to keep spending from that wallet.
- The `idlex-mcp` folder itself. Idlex ships it as a zip, not an npm package, so Nomad does not copy it.

## Worth a look

- **Without a key it only reads.** Market prices, quotes and job status work; paying does not. A good first step.
- **Limits.** Without the two limits, Idlex's defaults apply: 0.01 USDG per job and 0.10 USDG per session. A limit written as a reference on the source does not move, and the preview says so.
- **Another network.** When `IDLEX_API` points anywhere but `https://www.idlex.network`, the preview warns: the agent's wallet signs payments for the offers that address sends.
- **Another computer.** Download `idlex-mcp` from https://www.idlex.network/downloads/idlex-mcp.zip, unzip it at the same path, run `npm install` in it, and use Node.js 22.18 or later.
- **A fresh wallet.** Idlex suggests a wallet just for the agent, funded with only what it may spend. It needs USDG on Robinhood Chain and no ETH: Idlex pays the gas.
- **Look-alikes.** Only `node` running `idlex-mcp/src/server.ts` counts as Idlex. Other files move as ordinary servers, without Idlex's notes.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
