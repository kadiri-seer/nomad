# Stoa setups

Stoa is a swap router on Robinhood Chain and Elysium: for each swap it compares the venues it routes and returns the best route. Agents reach it through a hosted MCP server, `https://stoadex.com/mcp`, which lists tokens, quotes, checks a token by simulating a small buy and sell-back, and builds swaps. It needs no key and never signs or sends anything: every swap it builds is an unsigned transaction for the user's own wallet. Nomad moves that MCP entry and the `stoa` skill between agents. There are no keys or wallets involved.

The Stoa team asked Nomad to add its server and reviewed this guide on Nov 18, 2026. It follows Stoa's documentation (stoadex.com/docs/mcp), its skill (stoadex.com/skills/stoa/SKILL.md) and the server's public source, read Nov 18, 2026.

## What moves

- The hosted server, `https://stoadex.com/mcp`, in each destination's own format, exactly as written.
- The `stoa` skill, like any skill.

## Worth a look

- **Before you sign.** Stoa builds the transaction; your wallet decides. Check that it goes to Stoa's router for the chain, and approve only the amount the swap asks for. The preview names both:
  - Robinhood Chain (4663): `0x2F2804fad735a38015650f32f95Ad5E08D6B3eE5`
  - Elysium (99901): `0x104752D50ef893da579Ad813918269e09Ea17dbA`
- **Safety checks.** A token that passes Stoa's safety check passed it at that moment; its owner can change its rules later. A result of `unknown` is not a pass.
- **Look-alikes.** Only Stoa's own address counts as Stoa: `https://stoadex.com/mcp` over https on the standard port, with no user name in it. Anything else, `www.stoadex.com` and other paths included, moves as an ordinary server, without Stoa's note.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
