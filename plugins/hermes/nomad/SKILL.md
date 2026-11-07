---
name: nomad
description: Export, back up or move this Hermes profile to another agent platform with the Nomad CLI, previewing every change first.
---

# Nomad for Hermes

Install the skill folder in `~/.hermes/skills/nomad/` and make sure the `nomad` command is on PATH.

- Inspect this profile: `nomad inspect hermes` (or `hermes:~/.hermes#profile:<name>` for a named profile).
- Export: `nomad export hermes -o ~/agent-backups`.
- Preview a move: `nomad migrate --from hermes --to <platform> --dry-run`.
- Apply after the user agrees: run the same command with `--yes`.

Never pass `--include-secrets`. Hermes keeps secrets in `~/.hermes/.env`, which Nomad never reads. Tell the user to set the same variables on the destination.
Do not add any `--approve-*` flag unless the user approved that specific change.
