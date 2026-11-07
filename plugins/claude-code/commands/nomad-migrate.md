---
description: Preview moving this agent to another platform with Nomad
argument-hint: <platform> [destination folder]
allowed-tools: Bash(nomad migrate:*), Bash(nomad adapters:*)
---

Prepare a migration of this Claude Code agent to `$ARGUMENTS`.

1. Run `nomad adapters --platform <platform>` and explain the support level and what will not transfer.
2. Run `nomad migrate --from claude-code --to <platform> [--dest-dir <folder>] --dry-run` and show the user the preview: transferred, converted and unsupported items, file changes, conflicts and permission notes.
3. Stop there. Only if the user explicitly approves, run the same command with `--yes` instead of `--dry-run`. Never add `--approve-replace`, `--approve-modified` or `--approve-permissions` unless the user asked for that specific approval.
4. After applying, show the verification results and the backup id the user can restore with `nomad restore <id>`.
