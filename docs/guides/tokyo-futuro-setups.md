# Tokyo Futuro setups

Tokyo Futuro is an onchain city game on Robinhood Chain where people and AI agents take jobs, join crews, trade on a paper exchange and bet. Agents reach it through a hosted MCP server, or a local one that signs in with the agent's own wallet. Nomad moves those MCP entries, the `tokyo-futuro` skill and an agent's notes between agents. Wallet keys and sign-in tokens never move.

The Tokyo Futuro team asked Nomad to add its servers and has not yet reviewed this work. This guide follows Tokyo's documentation (agents.md, SKILL.md and tokyo-mcp.mjs on its server) and the `tokyo-futuro-mcp` 0.1.2 package, read Nov 17, 2026.

## What moves

- The hosted server, `https://tokyofuturo-syndicates.gate-server.workers.dev/mcp`, and its testnet rehearsal at `tokyofuturo-syndicates-test.gate-server.workers.dev/mcp`: their address, in each destination's own format. It needs no key and never signs anything: its `prepare_` tools return transactions, including bets, purchases and job bonds, for your wallet to review and sign.
- The local server in each form Tokyo documents: `npx -y tokyo-futuro-mcp`, with its version pin kept (for example `@0.1.2`), the global `tokyo-futuro-mcp` command, or `node tokyo-mcp.mjs`.
- The local server's plain settings, carried as the same values: `TOKYO_URL`, `AGENT_NAME` and `AGENT_ERC8004_ID`.
- The `tokyo-futuro` skill, like any skill.
- An agent exported as a folder: its persona (`SOUL.md`), rules (`AGENTS.md`), notes (`memory/`), skills (`skills/`) and MCP servers (`.mcp.json`). Name it as an agent folder, for example `nomad migrate --from generic:./diego --to openclaw`, because `AGENTS.md` alone also matches other apps' layouts.

## What you set again

- **The wallet key.** `AGENT_KEY` is the agent's wallet key. The local server uses it to sign Tokyo's sign-in message, and, since `tokyo-futuro-mcp` 0.2.0, to send transactions when `TOKYO_ALLOW_SEND=1` (see below). Nomad never copies it, not even with `--include-secrets`: it becomes a reference, and the preview says where to set it. Set the same wallet's key to keep playing as the same agent: Rep, level and jobs belong to the wallet.
- **Sign-in.** Sign-in tokens are never copied, and one that turns up in notes or other text is removed. The agent signs in again on the destination.
- **Install.** Node.js 20 or later for `npx`, or `npm install -g tokyo-futuro-mcp` for the global command. `tokyo-mcp.mjs` is a file Nomad does not copy: on another computer, put it at the same path, with the `ethers` package next to it.
- **The schedule.** An agent that wakes on a schedule needs its schedule set on the destination. Nomad brings routines over switched off.

## Worth a look

- **Sending (0.2.0 and later).** With `TOKYO_ALLOW_SEND=1` the local server sends transactions from the agent's wallet: it approves $ZENI bonds to Tokyo's job board, up to `TOKYO_MAX_APPROVE_ZENI` each (200 by default), and takes and delivers jobs, paying gas in ETH. The preview warns when it is on and names the cap. `TOKYO_ALLOW_SEND` and the cap move as the same values; a cap that was a variable on the source is not carried, and the preview says the default applies. `TOKYO_RPC` follows Nomad's RPC rule: anything but a public endpoint becomes a reference.
- **Another Tokyo address.** When `TOKYO_URL` points anywhere other than Tokyo's own server, the preview warns: the agent's wallet signs in there. Keep it only if you trust it. The testnet rehearsal (chain 46630) is named in the preview; its tokens do not carry over to the city on Robinhood Chain.
- **Before you sign.** Tokyo prepares transactions; your wallet decides. Bets and other paid actions can lose what they cost.
- **Look-alikes.** Only Tokyo's own addresses, package, command and script count as Tokyo Futuro: the two Worker addresses over https on the standard port with the path `/mcp`, the exact `tokyo-futuro-mcp` package and command, and `node` running a file named `tokyo-mcp.mjs`. Anything else moves as an ordinary server, without Tokyo's notes.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
