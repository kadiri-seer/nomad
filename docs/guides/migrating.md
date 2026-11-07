# Migration guide

## OpenClaw to Claude Code

```
nomad migrate --from openclaw --to claude-code --dry-run
```

- SOUL.md, IDENTITY.md and AGENTS.md become a Nomad section of `~/.claude/CLAUDE.md`. Your own CLAUDE.md content stays.
- MEMORY.md, USER.md and daily logs become `~/.claude/nomad/<agent>/memory.md`, imported from CLAUDE.md with `@`.
- Skills copy as skills. Cron jobs cannot run in Claude Code: they are listed with their schedule and prompt.
- `tools.deny` entries without a Claude Code equivalent (such as `browser`) are reported as not enforced.
- Use `--mode copy --name "Kestrel"` to create a subagent instead of changing your main configuration.

## Claude Code to Codex

- CLAUDE.md content and subagent prompts become a section of `AGENTS.md`.
- Permissions map to `approval_policy`, `sandbox_mode` and `network_access`, always choosing the stricter value.
- Slash commands become Codex custom prompts. MCP servers go into `config.toml` without secret values; set them in your environment.
- Anthropic models are not written into Codex.

## Hermes to OpenClaw, and back

- `MEMORY.md` and `USER.md` entries (separated by `§`) map to OpenClaw MEMORY.md and USER.md entries, one entry each.
- Cron jobs move in both directions and are always imported disabled (`openclaw cron enable <id>`, `hermes cron resume <id>`).
- Hermes enforces memory character limits. Nomad warns when an import exceeds them.
- `~/.hermes/.env` and `~/.openclaw/credentials` are never read: reconnect messaging platforms and API keys yourself.

## Packages

```
nomad export Kestrel -o ~/agent-backups
nomad validate ~/agent-backups/Kestrel.agentpack
nomad import ~/agent-backups/Kestrel.agentpack --to hermes --dry-run
```

Importing a package of an agent you already have creates a new version of the same agent, not a duplicate.

## Keeping copies in step

After an agent lives in several places, `nomad sync <agent>` previews pushing the primary location to the others in merge mode. Synchronisation is one way and explicit; nothing is synced automatically.

## Undo

Every migration prints a backup id. `nomad restore <id> --dry-run` shows what would change; `nomad restore <id>` puts files back and backs up the current state first.
