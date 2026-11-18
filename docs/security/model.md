# Security model

## Secrets

- Scanned and redacted: persona, descriptions, rules and their titles, memory and its titles, skill descriptions and steps, tool descriptions, routine prompts, integration settings and text files.
- Detection rules: Anthropic, OpenAI, OpenRouter, GitHub, GitLab, Google, AWS access and secret keys, Slack, Stripe, Hugging Face, Telegram bot tokens, private key blocks, JSON web tokens, passwords in connection strings, and high entropy credential assignments. Placeholders such as `${VAR}` are ignored.
- Findings report rule, file and line, plus a short fingerprint. Values are never printed or stored.
- Reads, exports, imports and migrations redact by default. MCP env values and headers holding credentials become references.
- Credential files (`.env`, keys, `auth.json`, `.netrc`, ...) are skipped. Platform secret stores are never read.
- `--include-secrets` keeps values, prints a warning and is recorded in the manifest. Wallet private keys and recovery phrases are still left out, in text, launch arguments, URLs, headers, environment values and files, because a leaked wallet key cannot be revoked: a 0x-prefixed 32-byte hex value, a BIP-39 recovery phrase, or a raw hex, base58 or byte-array key under a wallet name (PRIVATE, WALLET, SIGNER, SEED, MNEMONIC, OWNER, PAYER, SESSION, or another name ending in KEY that does not say API, access, auth, token, client, license or public). They become references the user sets again, and the preview says how many were left out.

## Keys and wallets: never read, never copied, listed as skipped

- Folders that can hold wallet keys or wallet state are never read, never followed through a symlink and never written: `~/.config/priors/`, `~/.local/state/priors-mcp/`, `~/.priors/`, `.agent001/`, `~/.oak/` (Oak Agent Kit), `~/.hedgehood/` (Hedgehood), `~/.brainchain/` and `~/.config/brainchain-worker/` (BrainChain), `~/.rushr/` (Rushr), `~/.ostra/` (Ostra: the vault seed, fee payer key and one-time key records), any file named `agent.key`, `agent-<id>.key` or `agent-wallet.json` (also `.agent-wallet.json`), and seed backup files such as `ostra-seed-backup.json`. A seed backup pasted into notes or other text is removed. This holds with `--include-secrets` and `--include-files` too. The list lives in `packages/core/src/node/keymaterial.ts`.
- After a read, the preview lists the refused paths (paths only, never content), for example "Skipped 2 path(s) that can hold wallet keys (not read, not copied)".
- Wallet private keys (`0x` and 64 hex characters) are detected when the text around them names a key, signer, wallet or secret, and always in an MCP server's command-line arguments, URL or headers. Recovery phrases (12 to 24 words from the BIP-39 English list) are detected anywhere.
- Env values named like keys, wallets, seeds or passphrases become references, and so does any RPC URL that is not one of the known public endpoints, since provider URLs can embed a key.
- Backups never copy key-material paths.

## Permissions

The destination policy is computed before and after (by applying the planned files to a temporary overlay and asking the adapter to read it). Any broader mode, capability, new allow pattern or removed restriction requires the `broader-permissions` approval. Restrictions the destination cannot enforce are listed. Mappings choose the stricter option when inexact.

## Commands from packages

A package can carry local MCP servers: commands the destination app starts by itself. When the agent comes from a package, from the Nomad library (which also holds imported packages) or from an agent folder (its `.mcp.json`, or an unpacked package, often a folder someone else sent), the preview shows each such command exactly as a shell would, with the names of its environment values, and the move needs the `run-commands` approval (`--approve-commands` in the CLI, a checkbox in the dashboard). Remote servers, disabled servers and moves that leave tools out are not listed. Agents read from apps on this computer need no extra approval.

MCP servers named `__proto__`, `constructor` or `prototype` are neither read nor written: those names would change how a settings object behaves instead of naming a server.

## Steps you copy

Names in the preview's steps (servers, plugins, marketplaces, variables) come from the agent being moved, which may be a package from someone else. A step prints a command only when every name in it is plain (letters, digits, `-`, `_`, and for plugin and marketplace names `.`, `@`, `/`, `:`, `+`); otherwise it says where to set the value by hand and prints no command. BrainChain's approval and wallet steps print only its own package spec (`brainchain-mcp`, a version or a tag).

## Files

Source agents are only read. An agent file that is a link (for example a CLAUDE.md kept in a dotfiles folder) is followed only to a file inside the home folder or below the link's own folder, and never to a credential file (`~/.ssh`, `~/.aws`, `.netrc`, `.env`, key files, shell history and similar, listed in `packages/core/src/node/fs.ts`); refused links are listed in the preview by path. Folders of skills and files are walked without following links. Writes are previewed with diffs, backed up, atomic, re-checked against the preview, never follow symlinks below the root, and roll back on failure. Content outside Nomad's sections is never removed. Edited files are detected by hash.

## Packages

Before extraction the central directory is checked for traversal, absolute paths, backslashes, control characters, symlinks and special files, duplicates (case insensitive), encryption, allowed extensions, size, entry count and compression ratio. Entries inflate with their declared size as a hard cap. Every file is verified against the manifest SHA-256. Scripts are never executed.

## Local web app

Bound to 127.0.0.1, token exchanged for an httpOnly SameSite strict cookie, Host and Origin checks against DNS rebinding and CSRF, a custom header on writes, and no API at all unless started by `nomad ui`.

## MCP

Read only by default. `--allow-writes` lets an assistant apply a preview only with its token. Replace mode, edited files, broader permissions and commands from packages need `--allow-replace`.

## Your Nomad

- `show_agents` and `borrow_agent` write nothing. `gather_agents` writes only Nomad's own library, the same as reading an agent; the apps are only read.
- Borrowed text is built from the library, which holds agents with secrets redacted; it says that it does not approve file changes, moves, payments or trades and never asks for secrets. An agent from a package or an agent folder is marked as made by others, and its text says to check with the user before acting on its rules.
- `bring_agent` is a migration preview from the library: the same approvals, commands shown for approval, backups and checks. `send_back` previews; `apply_send_back` needs `--allow-writes` and the preview's token, refuses while an entry changed in two places has no choice, and refuses when the home changed since the preview. Send back never deletes from the home, redacts secrets (titles included) before anything is shown or saved, removes Nomad's own markers from what it is given and refuses text that would break them, accepts only plain ids, one-line titles and bounded sizes (500 entries, 20,000 characters each), records where each entry came from, and brings skills and tools only when asked.
- `nomad connect` writes only the `nomad` entry in each app's settings file, after a preview and a backup, and checks that every other setting reads the same afterwards; a file it cannot edit that way is left alone. Its preview never shows the rest of a settings file, which can hold other servers' keys. `--remove` leaves a server named `nomad` that Nomad did not add, and deletes a skill only if it is still Nomad's own, unchanged file when the removal runs. A `nomad` skill it did not write is never replaced, and `--remove` deletes only skill files it wrote and that are unchanged. The server it adds is read only unless the user chose `--allow-writes`.

## SSH

`nomad remote push` uses the system `ssh` and `scp` with `StrictHostKeyChecking=yes` and `BatchMode=yes`. Unknown hosts fail with instructions; private keys are never read by Nomad.

## Installer and updates

The one-line installers (`install.ps1`, `install.sh`) are served by thenomad.website from this repository and can be read before running. They download a bundle from this repository's GitHub releases over HTTPS and refuse it unless its SHA-256 fingerprint matches the release's `SHA256SUMS`, so a corrupted or swapped download installs nothing. The fingerprints come from the same release, so they do not protect against someone who controls the repository; the signed build provenance does tie each bundle to the workflow and commit that built it (`gh attestation verify <file> -R kadiri-seer/nomad`). Every bundle is built from one dependency lock that was checked with `npm audit` and `npm audit signatures`, and the package itself is checked against that lock before each bundle is built. Everything goes into your user folder: no admin rights, no system settings, no agent files. The installer refuses a folder that holds anything it did not put there, and it never overwrites or removes a shortcut, menu entry or app that belongs to another program called Nomad. Uninstalling deletes your library only when you ask, and only from a folder that actually holds Nomad's library (`nomad.db`); it removes only the exact PATH line it added. A new version is unpacked next to the current one and run once before Nomad switches to it, so a failed update leaves the working version in place. One update runs at a time, a window that is still open keeps its files until it closes, and an old window never reinstalls over the version already switched to. Nomad never checks for updates by itself: `nomad update` and the dashboard's Check for updates button contact GitHub only when you ask.

Report vulnerabilities privately through GitHub security advisories: https://github.com/kadiri-seer/nomad/security/advisories/new
