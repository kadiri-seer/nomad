# Kudo setups

Kudo records promises between AI agents as covenants on Robinhood Chain. Each covenant is an NFT that holds an ask (what the other agent does) and a promise (what this agent does in return). Kudo's Evaluator checks the proof and rules each promise kept or broken, and the verdict goes on a public record tied to the agent's ERC-8004 identity. Kudo never moves tokens: a promise to pay is paid from the agent's own wallet. Nomad moves Kudo's server and skill between agents and apps, along with the rest of the agent.

Kudo has not reviewed this guide or Nomad's handling of its setups. It follows Kudo's docs ([docs.kudo.archi/integrate](https://docs.kudo.archi/integrate)), its MCP server `@kudo-dev/mcp` 0.1.0 and its `kudo` skill, read Nov 27, 2026.

## Connect Kudo

Open [app.kudo.archi](https://app.kudo.archi/dashboard) and choose **Connect your agent**. Kudo offers three ways in:

- **The MCP server**, for Claude Code, Codex, Cursor, Windsurf and Claude Desktop: `npx -y @kudo-dev/mcp`. In Claude Code: `claude mcp add kudo -e KUDO_PRIVATE_KEY=0x… -e KUDO_AGENT_ID=123 -- npx -y @kudo-dev/mcp`. Leave out `KUDO_PRIVATE_KEY` and its write tools return unsigned transactions for your own wallet to sign.
- **The skill file**, for Claude Code, OpenClaw, Hermes and any app that reads Markdown skills: [skills/kudo/SKILL.md](https://github.com/Kudo-Agentic/kudo-agent/blob/main/packages/sdk/skills/kudo/SKILL.md). It uses Foundry's `cast`, and signs with `PRIVATE_KEY` from the shell.
- **The ElizaOS plugin**, `@kudo-dev/plugin-kudo`, added to the character's plugins.

The wallet needs a little ETH on Robinhood Chain for gas while Kudo's gas sponsorship is off.

## What moves

- The MCP server, `npx -y @kudo-dev/mcp`, in each destination's own format, with `KUDO_AGENT_ID` and any `KUDO_RPC_URL` as written.
- The wallet key, as a reference only. `KUDO_PRIVATE_KEY` is never copied: the destination reads it from its own setting (`env_vars` in Codex, `${KUDO_PRIVATE_KEY}` elsewhere), and the preview says to set it to the same wallet's key.
- The `kudo` skill and the files beside it, such as `sponsored-send.mjs`.
- The agent's instructions, including any rule about what it may promise.

## What does not move

- **The wallet key.** The agent's ERC-8004 identity and its kept-or-broken record belong to its wallet. Set the same wallet's key in the new app to keep them; a new key is a new wallet, which must register again.
- **A key from a Phala TEE.** With `KUDO_KEY_SOURCE=dstack` the key is made inside the enclave and never leaves it. Outside that enclave the server has no key, and a new Phala app gets a new key and wallet. The preview warns about this.
- **The ElizaOS plugin**, to apps that use MCP servers. Nomad points to Kudo's MCP server instead; it never installs plugins.

## Worth a look

- **Promises are permanent.** Covenant text is public and cannot be changed. For any payment, Kudo asks that the amount and the token are in the covenant text. Check this agent's instructions in the new app for what it may promise.
- **Signing.** With a key, the server signs and sends Kudo transactions from the agent's wallet by itself. Without one, it only returns them for you to sign.
- **Another RPC.** A `KUDO_RPC_URL` other than Robinhood Chain's public one moves as written, with a warning: an RPC address can hold a provider's key.
- **The skill needs tools.** The `kudo` skill runs `cast` (Foundry 1.x) and, for Kudo's gas relay, `node`. Install them where the new app runs.
- **Look-alikes.** Only Kudo's own package counts: exactly `@kudo-dev/mcp` (any version), or its installed `kudo-mcp` command. Anything else moves as an ordinary server, without these notes.

## Checked

See [STATUS](../STATUS.md) for what was tested.
