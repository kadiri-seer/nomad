---
name: nomad
description: Export, back up or move this OpenClaw agent to another platform (Claude Code, Codex, Hermes and more) using the Nomad CLI, always previewing first.
metadata: {"openclaw": {"requires": {"bins": ["nomad"]}}}
---

# Nomad

Use the `nomad` command line to work with portable copies of this agent.

- Inspect: `nomad inspect openclaw` lists what the agent contains. Secrets are redacted.
- Export: `nomad export openclaw -o ~/agent-backups` writes a `.agentpack`.
- Back up: `nomad backup <agent name>` snapshots the workspace files.
- Move: `nomad migrate --from openclaw --to <platform> --dry-run` shows a preview. Tell the user what transfers, what is converted, what cannot move, and which files change.

Rules:

1. Always run the preview first and show it to the user.
2. Apply only after the user says so, by running the same command with `--yes`.
3. Never add `--approve-replace`, `--approve-modified`, `--approve-permissions` or `--include-secrets` unless the user asked for that exact thing.
4. Imported routines are always disabled. Tell the user how to enable them on the destination.
