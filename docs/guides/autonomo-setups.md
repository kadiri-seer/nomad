# Autonomo setups

Autonomo is a marketplace of paid APIs for agents: the agent pays per call over x402, in USDG or $AUTONOMO on Robinhood Chain or USDC on Base, with no account and no API key. Agents reach it through a local MCP server, `npx -y autonomo-mcp`, and the `autonomo` skill, which uses the `autonomo-sdk` command. Nomad moves both between agents and apps, along with the rest of the agent.

Autonomo has not reviewed this guide or Nomad's handling of its setups. It follows Autonomo's agents guide, autonomo-mcp 0.1.3 and its skill, read Nov 27, 2026.

## What moves

- The MCP server's entry, in each destination's own format, exactly as written (a Windows `cmd /c npx -y autonomo-mcp` entry moves as it is).
- The spending limits and the token to pay with, when they are written as values: `AUTONOMO_MAX_USDG_PER_CALL`, `AUTONOMO_DAILY_USDG`, `AUTONOMO_MAX_AUTONOMO_PER_CALL`, `AUTONOMO_DAILY_AUTONOMO` and `AUTONOMO_PAY_WITH`. The preview lists them, with the defaults where none are set.
- The `autonomo` skill, like any skill.
- The agent's instructions, including any rule about checking a price before paying.

## What does not move

- **The wallet key.** `AUTONOMO_WALLET_KEY` is never copied, even when it was typed straight into a settings file. The destination gets a reference to it under the same name: in Claude Code `${AUTONOMO_WALLET_KEY}`, in Codex `env_vars = ["AUTONOMO_WALLET_KEY"]`, which both read from the environment the app starts in. Set it there yourself. Until then the agent finds APIs and checks prices, but cannot pay.
- **What was spent today.** The day's spending is kept on the computer, not in the agent.

## Worth a look

- **Limits per computer.** The MCP server counts the day's spending in `~/.autonomo-mcp/spend.json`, shared by every app on that computer. On another computer the count starts again at zero, so keep the wallet's balance small.
- **The skill keeps its own limits.** The `autonomo-sdk` command reads the key from your shell and has its own limits (0.05 dollars a call and 1 dollar a day unless the agent passes `--max` and `--daily`), apart from the MCP server's.
- **Windows entries.** `cmd /c` only works on Windows. On a Mac or Linux, change the command to `npx -y autonomo-mcp`.
- **Gateways.** The server pays only Autonomo's gateways at `https://autonomo.fun`. If `AUTONOMO_BASE_URL` points anywhere else, the preview warns.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
