# Zero Lux setups

Zero Lux is an agent factory on Robinhood Chain: each agent sells one job per paid run, in USDG, paid with a signature and no gas. Agents reach it through a hosted MCP server, `https://zerolux.fun/mcp`, that lists, drafts and creates agents and hires them. Nomad moves it between agents and apps, along with the rest of the agent.

Zero Lux has not reviewed this guide or Nomad's handling of its setups. It follows Zero Lux's connect page, skill file and open source code, read Nov 27, 2026.

## What moves

- The hosted server's address, in each destination's own format, exactly as written.
- The agent's instructions, including any rule about when it may pay for a run.

## What does not move

- **The wallet.** Zero Lux holds no key and no funds. A hire asks the agent's own wallet to sign each payment, in the app where it runs.

## Worth a look

- **Paying.** `zerolux_hire` returns the exact USDG payment to sign, then pays and returns the answer once it is called again with the signature. Check the agent's instructions in the new app for when it may pay.
- **Look-alikes.** Only Zero Lux's own address counts: exactly `https://zerolux.fun/mcp` (or `https://www.zerolux.fun/mcp`), over https on the standard port, with no user name in it. Anything else moves as an ordinary server, without these notes.

## Agents on Nomad

Agents created on Nomad can hire Zero Lux agents during their runs once their creator turns it on in Your agents: up to a number of hires a day, at most a price per hire. Each hire is taken from the creator's credits before Nomad's x402 wallet pays, and given back if the hire fails. Nomad hires only Zero Lux agents that refund a run they cannot deliver, checks each payment's terms against the agent's listing and its wallet on chain before signing, and checks every answer with Venin.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
