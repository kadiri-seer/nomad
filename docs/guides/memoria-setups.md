# Memoria setups

Memoria is a shared memory service for AI agents. Agents save what they learn, with a reason, a topic and how confident they are, and find it again by asking a question. A memory is private to the agent that saved it until that agent shares it with named agents in the same account, and every version is signed for the agent that wrote it. Agents reach Memoria through a hosted MCP server, `https://www.memoriaagent.site/mcp`. Nomad moves that MCP entry between agents, and never copies the key.

Memoria's team has not reviewed this guide yet. It follows Memoria's documentation (memoriaagent.site and /docs.html) and the server's public source, read Nov 19, 2026.

## What moves

- The hosted server, `https://www.memoriaagent.site/mcp`, in each destination's own format, exactly as written.
- The API key, as a reference only. Whether the source held the key in its config (`Authorization: Bearer mem_...`) or in a variable, the destination reads it from `MEMORIA_API_KEY`, holding the key alone:

| Destination | What Nomad writes |
| --- | --- |
| Codex | `bearer_token_env_var = "MEMORIA_API_KEY"` |
| Claude Code, Gemini CLI, Hermes | `Authorization: Bearer ${MEMORIA_API_KEY}` |
| Cursor | `Authorization: Bearer ${env:MEMORIA_API_KEY}` |
| OpenClaw | No header: a step shows how to add `Bearer ${MEMORIA_API_KEY}` with `openclaw config set`, once `MEMORIA_API_KEY` is set |

If the source already kept the key alone in a variable of its own (`Bearer ${MY_KEY}`, or Codex's `bearer_token_env_var`), that name is kept.

The memories themselves are not copied: they stay on Memoria's server.

## Worth a look

- **The key is the agent.** Each key belongs to one agent and decides which agent a memory is saved as. With the same key, the agent keeps reading and saving the same memories in the new app. A different key is a different agent, which sees only the memories shared with it.
- **Set the key before you start the app.** Memoria refuses every request without a valid key, so the server does not work until `MEMORIA_API_KEY` is set. A setup with no key gets a step saying so.
- **Keys in text.** A Memoria key pasted into instructions or notes is removed, like any other secret.
- **Look-alikes.** Only Memoria's own address counts as Memoria: `https://www.memoriaagent.site/mcp` over https on the standard port, with no user name in it. Anything else, a Memoria running on your own computer included, moves as an ordinary server, without Memoria's notes.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
