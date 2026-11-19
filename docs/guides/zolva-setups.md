# Zolva setups

Zolva is open trading-agent infrastructure on Robinhood Chain: people build trading agents for tokenized US stocks, ETFs and crypto, backtest them, and run them on paper or with real money from their own wallet, with every decision public. Agents reach Zolva through a hosted MCP server, `https://zolvaagent.app/mcp`. Without a key it has seven read-only tools: agents, markets, recent activity, consensus and a replay that checks a published agent. An optional API key adds tools for the scopes it holds. Nomad moves that MCP entry between agents, and never copies the key.

The Zolva team asked Nomad to add its server and tested this work before release on Nov 19, 2026. It follows Zolva's documentation (zolvaagent.app/docs/mcp, /docs/public-api and /llms.txt) and the server's public source, read Nov 19, 2026.

## What moves

- The hosted server, `https://zolvaagent.app/mcp`, in each destination's own format, exactly as written.
- The API key, as a reference only. Whether the source held the key in its config (`Authorization: Bearer zk_...`, as Claude Code and Cursor write it) or in a variable, the destination reads it from `ZOLVA_KEY`, holding the key alone:

| Destination | What Nomad writes |
| --- | --- |
| Codex | `bearer_token_env_var = "ZOLVA_KEY"`, as Zolva's docs set it up |
| Claude Code, Gemini CLI, Hermes | `Authorization: Bearer ${ZOLVA_KEY}` |
| Cursor | `Authorization: Bearer ${env:ZOLVA_KEY}` |
| OpenClaw | No header: a step shows how to add `Bearer ${ZOLVA_KEY}` with `openclaw config set`, once `ZOLVA_KEY` is set |

If the source already kept the key alone in a variable of its own (`Bearer ${MY_KEY}`, or Codex's `bearer_token_env_var`), that name is kept.

A setup with no key stays keyless: no header and no step.

## Worth a look

- **Set the key before you start the app.** Zolva refuses a missing, empty or wrong key, and some apps do not start a server whose variable is unset, so until `ZOLVA_KEY` is set the server does not work, keyless tools included. To use Zolva without a key, leave out its key setting.
- **Scopes.** A key adds tools for the scopes it holds: `agents:write` creates, pauses and publishes paper agents, `ai` spends your AI credits, and `live:stop` can stop a real-money agent. New keys start with `read:private` and `compute`. Give the key only the scopes the agent needs. Zolva never moves funds through MCP; real-money agents are created and changed in the browser.
- **Keys in text.** A Zolva key pasted into instructions or notes is removed, like any other secret.
- **Look-alikes.** Only Zolva's own address counts as Zolva: `https://zolvaagent.app/mcp` over https on the standard port, with no user name in it. Anything else, `www.zolvaagent.app` and other paths included, moves as an ordinary server, without Zolva's notes.

## Bearer tokens for other servers

The same handling applies to any remote server whose key is kept alone in a variable: Codex's `bearer_token_env_var` is read and written, and a header written as `Bearer ${NAME}` keeps `NAME` when it moves.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
