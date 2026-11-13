# Security model

## Secrets

- Detection rules: Anthropic, OpenAI, OpenRouter, GitHub, GitLab, Google, AWS access and secret keys, Slack, Stripe, Hugging Face, Telegram bot tokens, private key blocks, JSON web tokens, passwords in connection strings, and high entropy credential assignments. Placeholders such as `${VAR}` are ignored.
- Findings report rule, file and line, plus a short fingerprint. Values are never printed or stored.
- Reads, exports, imports and migrations redact by default. MCP env values and headers holding credentials become references.
- Credential files (`.env`, keys, `auth.json`, `.netrc`, ...) are skipped. Platform secret stores are never read.
- `--include-secrets` keeps values, prints a warning and is recorded in the manifest.

## Keys and wallets: never read, never copied, listed as skipped

- Folders that can hold wallet keys or wallet state are never read, never followed through a symlink and never written: `~/.config/priors/`, `~/.local/state/priors-mcp/`, `~/.priors/`, `.agent001/`, and any file named `agent.key` or `agent-<id>.key`. This holds with `--include-secrets` and `--include-files` too. The list lives in `packages/core/src/node/keymaterial.ts`.
- After a read, the preview lists the refused paths (paths only, never content), for example "Skipped 2 path(s) that can hold wallet keys (not read, not copied)".
- Wallet private keys (`0x` and 64 hex characters) are detected when the text around them names a key, signer, wallet or secret, and always in an MCP server's command-line arguments, URL or headers. Recovery phrases (12 to 24 words from the BIP-39 English list) are detected anywhere.
- Env values named like keys, wallets, seeds or passphrases become references, and so does any RPC URL that is not one of the known public endpoints, since provider URLs can embed a key.
- Backups never copy key-material paths.

## Permissions

The destination policy is computed before and after (by applying the planned files to a temporary overlay and asking the adapter to read it). Any broader mode, capability, new allow pattern or removed restriction requires the `broader-permissions` approval. Restrictions the destination cannot enforce are listed. Mappings choose the stricter option when inexact.

## Files

Source agents are only read. Writes are previewed with diffs, backed up, atomic, re-checked against the preview, never follow symlinks below the root, and roll back on failure. Content outside Nomad's sections is never removed. Edited files are detected by hash.

## Packages

Before extraction the central directory is checked for traversal, absolute paths, backslashes, control characters, symlinks and special files, duplicates (case insensitive), encryption, allowed extensions, size, entry count and compression ratio. Entries inflate with their declared size as a hard cap. Every file is verified against the manifest SHA-256. Scripts are never executed.

## Local web app

Bound to 127.0.0.1, token exchanged for an httpOnly SameSite strict cookie, Host and Origin checks against DNS rebinding and CSRF, a custom header on writes, and no API at all unless started by `nomad ui`.

## MCP

Read only by default. `--allow-writes` lets an assistant apply a preview only with its token. Replace mode, edited files and broader permissions need `--allow-replace`.

## SSH

`nomad remote push` uses the system `ssh` and `scp` with `StrictHostKeyChecking=yes` and `BatchMode=yes`. Unknown hosts fail with instructions; private keys are never read by Nomad.

Report vulnerabilities privately through GitHub security advisories: https://github.com/kadiri-seer/nomad/security/advisories/new
