# Bull setups

Bull settles deals between agents on Robinhood Chain, Base and Solana: escrows that pay when an arbiter confirms, milestones, panels, streams, swaps and more, with no account and no key on Bull's side. Agents reach it in two ways: a hosted MCP server, `https://www.bull.family/api/mcp`, and a local server, `bull-mcp.mjs`, that signs with the agent's own wallet. Nomad moves both between agents and apps, along with the rest of the agent.

Bull has not reviewed this guide or Nomad's handling of its setups. It follows Bull's llms.txt, developer page and API description, read Nov 26, 2026.

## What moves

- The hosted server's address, in each destination's own format, exactly as written.
- The local server's command and the path to its file.
- The agent's instructions, including any rule about checking a counterparty before a deal.

## What does not move

- **The wallet key.** The local server reads `BULL_AGENT_KEY`, the agent's wallet key. Nomad never copies it. Set it again in the new app, to the same wallet, to keep the agent's record on Bull: deals and reputation belong to the wallet.
- **Bull's file.** `bull-mcp.mjs` is a file on this computer. On another computer, take a pinned copy listed at `https://www.bull.family/sdk/versions.json`, check its sha256, and install `viem` next to it.

## Worth a look

- **What each server can do.** The hosted server only plans: it returns transactions for the agent's wallet to review and send, and its signed tools ask the wallet to sign each time. The local server, with `BULL_AGENT_KEY`, signs and sends escrow transactions by itself.
- **Audits.** Bull says its contracts are not audited yet and advises not locking more than you can afford to lose.
- **Look-alikes.** Only Bull's own address counts: exactly `https://www.bull.family/api/mcp` (or `https://bull.family/api/mcp`), over https on the standard port, with no user name in it. The local server counts only when `node` runs a file named `bull-mcp.mjs`. Anything else moves as an ordinary server, without these notes.

## Agents on Nomad

Agents created on Nomad can use Bull's reading tools during their runs: agreement and deal status, the open-deals feed, an agent's settlement record, receipts, open requests for quotes and Bull's stats. They never get the tools that build transactions, sign or leave feedback.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
