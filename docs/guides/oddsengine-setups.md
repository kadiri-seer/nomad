# OddsEngine setups

OddsEngine runs crypto safety checks and AI models behind one key, through a hosted MCP server, `https://api.oddsengine.live/mcp`. Its safety tools (`scan_token`, `check_before_sign`, `wallet_approvals`, `trace_wallet`, `money_out`, `drain_report`) only read and never move funds. Its other tools answer with models from other companies (`list_models`, `estimate_cost`, `chat`, `compare`, `balance`), and since Nov 28, 2026 also generate images, voice, 3D and video and rent GPUs: those spend more of the balance per call. Every call is paid from your OddsEngine balance. Nomad moves that MCP entry between agents, and never copies the key.

This follows what OddsEngine's team described to Nomad on Nov 22, 2026, and OddsEngine's team reviewed this guide the same day.

## Connect OddsEngine

Powered by OddsEngine. Three steps, on [engine.oddsengine.live/?ref=nomad](https://engine.oddsengine.live/?ref=nomad):

1. Connect a wallet. It only asks you to sign a message: no transaction, no fee.
2. Top up your balance with $ODDS.
3. Under **API keys**, create a key (it starts with `oe_live_` and is shown once), then set it as `ODDSENGINE_API_KEY` where your app reads it (the table below).

Through that link, OddsEngine gives MCP access without holding $ODDS. Safety checks cost $0.02 per call. Holders pay a lower fee on the AI models. OddsEngine says the first 100 wallets that come through Nomad get $1 of starter credit from them.

**Without a key: pay per call.** OddsEngine also offers keyless use, where each call is paid on its own instead of from a balance: as OddsEngine listed it on Nov 27, 2026, $0.02 a scan and $0.015 a check. How an app pays this way is set up with OddsEngine, on [engine.oddsengine.live](https://engine.oddsengine.live/?ref=nomad). Nomad moves a keyless setup as it is: there is no key to keep out, and the destination gets the same address. Nomad's own hosted agents use a key.

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

- **Calls cost money.** Every call, the safety checks included, is paid from your OddsEngine balance. The AI, generation and GPU tools cost more per call. Give an agent the key only if you are fine with it spending that balance.
- **The key is needed to run a tool, not to connect.** Without a key the server still connects and lists its tools, but OddsEngine refuses each call until `ODDSENGINE_API_KEY` is set (or the call is paid per call, below). A setup with no key gets a step with the link above.
- **Keys in text.** An OddsEngine key pasted into instructions or notes is removed, like any other secret.
- **Look-alikes.** Only OddsEngine's own address counts as OddsEngine: `https://api.oddsengine.live/mcp` (or `/mcp/k/...`) over https on the standard port, with no user name in it. Anything else moves as an ordinary server, without OddsEngine's notes.

## Checked

See [STATUS](../STATUS.md) for what was tested.
