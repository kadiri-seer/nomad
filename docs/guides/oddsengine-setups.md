# OddsEngine setups

OddsEngine runs crypto safety checks and AI models behind one key, through a hosted MCP server, `https://api.oddsengine.live/mcp`. Its safety tools (`scan_token`, `check_before_sign`, `wallet_approvals`, `trace_wallet`, `money_out`, `drain_report`) only read and never move funds; its AI tools (`list_models`, `estimate_cost`, `chat`, `compare`, `balance`) answer with models from other companies. Every call is paid from your OddsEngine balance. Nomad moves that MCP entry between agents, and never copies the key.

This follows what OddsEngine's team described to Nomad on Nov 22, 2026. OddsEngine has not reviewed this guide yet.

## Connect OddsEngine

Powered by OddsEngine. Three steps, on [engine.oddsengine.live/?ref=nomad](https://engine.oddsengine.live/?ref=nomad):

1. Connect a wallet. It only asks you to sign a message: no transaction, no fee.
2. Top up your balance with $ODDS.
3. Under **API keys**, create a key (it starts with `oe_live_` and is shown once), then set it as `ODDSENGINE_API_KEY` where your app reads it (the table below).

Through that link, OddsEngine gives MCP access without holding $ODDS. Holders pay a lower fee. OddsEngine says the first 100 wallets that come through Nomad get $1 of starter credit from them.

## What moves

- The hosted server, `https://api.oddsengine.live/mcp`, in each destination's own format.
- The API key, as a reference only. Whether the source held the key in its config (`Authorization: Bearer oe_live_...`) or in a variable, the destination reads it from `ODDSENGINE_API_KEY`, holding the key alone:

| Destination | What Nomad writes |
| --- | --- |
| Codex | `bearer_token_env_var = "ODDSENGINE_API_KEY"` |
| Claude Code, Gemini CLI, Hermes | `Authorization: Bearer ${ODDSENGINE_API_KEY}` |
| Cursor | `Authorization: Bearer ${env:ODDSENGINE_API_KEY}` |
| OpenClaw | No header: a step shows how to add `Bearer ${ODDSENGINE_API_KEY}` with `openclaw config set`, once `ODDSENGINE_API_KEY` is set |

If the source already kept the key alone in a variable of its own (`Bearer ${MY_KEY}`, or Codex's `bearer_token_env_var`), that name is kept.

- A key in the address. OddsEngine also accepts the key as part of the address (`https://api.oddsengine.live/mcp/k/<key>`), for apps that take only an address. Nomad takes the key out: the destination gets the plain address and the key as a header from `ODDSENGINE_API_KEY`, so the key stays out of the app's settings.
- A short `oddsengine-credit` skill (an instruction where the app has no skills), added once at OddsEngine's request: when the agent shows the result of `scan_token` or `check_before_sign`, it ends with "Checked by OddsEngine." It says that Nomad added it. Delete it any time; that does not affect OddsEngine.

## Worth a look

- **Calls cost money.** Every call, the safety checks included, is paid from your OddsEngine balance, and the AI tools cost more per call. Give an agent the key only if you are fine with it spending that balance.
- **Set the key before you start the app.** OddsEngine refuses calls without a valid key, so the server does not work until `ODDSENGINE_API_KEY` is set. A setup with no key gets a step with the link above.
- **Keys in text.** An OddsEngine key pasted into instructions or notes is removed, like any other secret.
- **Look-alikes.** Only OddsEngine's own address counts as OddsEngine: `https://api.oddsengine.live/mcp` (or `/mcp/k/...`) over https on the standard port, with no user name in it. Anything else moves as an ordinary server, without OddsEngine's notes.

## Checked

See [STATUS](../STATUS.md) for what was tested.
