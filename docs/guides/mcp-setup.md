# Nomad MCP: setup

Nomad's MCP server lets an assistant in your apps list your agents, check what a move would keep, preview it and, if you allow it, apply it after you approve.

## 1. Connect Nomad to your apps

```
npx thenomad connect
```

Nomad finds your apps (Claude Code, Codex, OpenClaw, Hermes, Gemini CLI, Cursor, the Claude desktop app), shows a preview and asks before changing anything. Every file it changes is backed up. Restart your apps afterwards.

Or add it by hand to any MCP client, as a server that runs:

```
npx -y thenomad mcp
```

For example, in Claude Code: `claude mcp add nomad -- npx -y thenomad mcp`

## 2. Choose what assistants may do

- **Default: read only.** Assistants can list agents, check compatibility, preview moves and export packages. Nothing on your computer changes.
- **`--allow-writes`:** assistants can apply a move, but only one you have seen previewed and approved (`npx thenomad connect --allow-writes`).

## 3. Ask your assistant

- "Show my agents"
- "Can my agent move to Codex?"
- "Move my agent to OpenClaw"

You always see a preview first. Nothing changes until you say yes.

## Check or remove

```
npx thenomad connect --status
npx thenomad connect --remove
```

More: [Your Nomad](your-nomad.md) (borrowing, bringing and sending back agents) and the [security model](../security/model.md).
