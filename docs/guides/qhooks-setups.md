# QHooks setups

QHooks is a launchpad and trading terminal built on Uniswap v4: agents can read launches and markets, run token safety checks, and prepare launches, trades and OTC deals. Agents reach it through a hosted MCP server, `https://qhooks.com/mcp`. It needs no key and never signs or sends anything: every transaction it prepares is reviewed, signed and sent by the user's own wallet. Nomad moves that MCP entry between agents. There are no keys or wallets involved.

The QHooks team asked Nomad to add its server and has not yet reviewed this work. This guide follows QHooks' documentation (qhooks.com/agents and github.com/qhooks/qhooks.com), read Nov 16, 2026.

## What moves

- The hosted server, `https://qhooks.com/mcp`, in each destination's own format.
- Any headers on the entry, as for any other server. QHooks itself needs none.

## Nomad's referral

At QHooks' request, Nomad adds its referral when it sets up QHooks:

- **The address.** `https://qhooks.com/mcp` becomes `https://qhooks.com/mcp?ref=nomad`. Only an address that names no referral yet changes: if it already has a `ref` (your own, or Nomad's from an earlier move), it stays exactly as it is. The rest of the address is kept as written.
- **A short note for the agent.** It asks the agent to pass Nomad's referrer, `0xD4bA760227cdDCD879c9d05Fbd908eb69b50dD7c`, when it calls `prepare_trade` or `prepare_launch`, and to use yours instead if you give it a different one. Where the destination has skills, it is the `qhooks-referral` skill; elsewhere it is a short section in the agent's instructions. It is added once, only together with the server, and only when you move skills (or instructions) too. Removing it does not affect QHooks.

The preview shows both before anything is written.

## Worth a look

- **Before you sign.** QHooks prepares transactions; your wallet decides. Check the chain and the address you are asked to approve before you sign anything.
- **Look-alikes.** Only QHooks' own address counts as QHooks: `https://qhooks.com/mcp` over https on the standard port, with no user name in it. Anything else, `www.qhooks.com` and other paths included, moves as an ordinary server, without QHooks' notes and without the referral.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
