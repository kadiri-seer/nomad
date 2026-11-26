# Virtuals setups

Virtuals Protocol runs agents with their own wallets, email inboxes and payment cards, and a marketplace (ACP) where agents hire each other. Agents reach it in two ways: a hosted MCP server, `https://mcp.acp.virtuals.io/`, and the `acp` command from `@virtuals-protocol/acp-cli`, driven by its `acp-cli` skill. Nomad moves both between agents and apps, along with the rest of the agent.

Virtuals has not reviewed this guide or Nomad's handling of its setups. It follows the acp-cli source and skill (github.com/Virtual-Protocol/acp-cli), the deprecated openclaw-acp skill (github.com/Virtual-Protocol/openclaw-acp) and the Virtuals plugin documentation for Base MCP, read Nov 26, 2026.

## What moves

- The hosted server's address, in each destination's own format, exactly as written.
- The `acp-cli` skill, like any skill.
- The agent's instructions, including any rule about asking before it pays or hires another agent.

## What does not move

- **Sign-ins.** The hosted server signs in with a short-lived session token the agent gets by signing a login message with a wallet; sign in again in the new app. The `acp` command keeps its sign-in tokens and signing keys in the system keychain (or `keyring/secrets.json` when there is none) and its account state in `~/.config/acp`. Nomad never reads any of them.
- **The old skill's key.** The deprecated `virtuals-protocol-acp` skill keeps `LITE_AGENT_API_KEY` and its session in `config.json` inside its own folder. Nomad moves the rest of that skill but never that file. Virtuals asks everyone to use `acp-cli` instead.

## Worth a look

- **What the hosted server can do.** It manages the agent's Virtuals identity, issues payment cards and sets their limits, and reads and sends the agent's email. Check the agent's instructions in the new app before it signs in.
- **The same computer.** The `acp` command is signed in per computer, not per app. Moved to another app on the same computer, the agent can use it straight away, including sending from its wallet, trading and paying with its card, within its signer's policy. On another computer, sign in there with `acp configure`, and add a signer with `acp agent add-signer` before anything that signs.
- **Look-alikes.** Only Virtuals' own address counts: exactly `https://mcp.acp.virtuals.io/`, over https on the standard port, with no user name in it. Anything else moves as an ordinary server, without these notes. The skill notes only apply to skills carrying Virtuals' own markers.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
