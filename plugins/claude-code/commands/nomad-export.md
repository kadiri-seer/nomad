---
description: Export this Claude Code agent to a portable .nomad file
argument-hint: [output folder]
allowed-tools: Bash(nomad export:*), Bash(nomad inspect:*)
---

Export the current Claude Code configuration with Nomad.

1. Run `nomad inspect claude-code:$PWD` if a `.claude` folder exists in the current project, otherwise `nomad inspect claude-code`. Summarise what the agent contains and any secrets Nomad reported as redacted.
2. Run `nomad export claude-code:$PWD -o ${ARGUMENTS:-.}` (or `nomad export claude-code -o ...` for the user configuration).
3. Report the package path. Do not use `--include-secrets` unless the user explicitly asked for it.
