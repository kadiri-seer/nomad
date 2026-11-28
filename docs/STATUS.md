# Implementation status

Report per phase of the product specification. Tests: `pnpm test` (84 tests).

## Phase 1: Core portability engine (done)

Implemented: UAF schema with Zod and generated JSON Schema, versioning and upgrade hook, ULID identity, `.nomad` format 2 (compact Markdown layout) with SHA-256 integrity and Ed25519 signing, legacy `.agentpack` reading, guided `nomad` and one-line `nomad move`, hardened ZIP reader, secret scanning and redaction, adapter contract, generic folder adapter, export, import, validation, migration reports.

Tested: exact round trips, tampering, traversal, absolute paths, backslashes, symlinks, duplicates, decompression bombs, unknown file types, malformed manifests, newer schema versions, unknown extensions, secret detection and redaction, no empty files.

## Phase 2: Platform adapters (done, partial support)

OpenClaw, Claude Code, Codex and Hermes read and write, each with a capability matrix and documented limitations. All four pass the adapter contract against fixtures modelled on the documented layouts.

Verified with real applications (`scripts/verify-real-apps.sh`): Codex CLI accepts the generated `config.toml` and lists migrated MCP servers; Claude Code shows migrated MCP servers from `~/.claude.json`.

The Real apps workflow (`scripts/check-real-apps.mjs`) installs the current Codex CLI, Gemini CLI and OpenClaw every week and after adapter changes, moves a Claude Code agent with a local server, a web server and a secret to each, and checks that each app lists every server with the right command, arguments and URL, that the instructions arrived, that OpenClaw accepts its config, and that no secret value was written. Checked locally on Nov 16, 2026 with Codex CLI 0.169.0, Gemini CLI 0.68.0 and OpenClaw 2026.9.2.

Not verified with the real application: OpenClaw (its current release needs Node 24.16+, not available in the build environment) and Hermes (Python). Their file formats follow the published documentation; field level details of cron job stores may differ between releases, which is why they are labelled partial.

## Phase 3: Web application (done)

Landing page with a live compatibility demo, in-browser package inspector, documentation, terms, privacy, custom 404 and favicon. Local dashboard: overview with machine scan, agents, agent details, versions with comparison and restore, the ten step migration wizard, import, export with download, platform compatibility, migration history with receipts, backups with restore preview, settings. Checked at desktop and mobile widths for overflow.

## Phase 4: Expanded platforms (done)

Cursor, Windsurf, Cline, Roo Code, Continue, OpenCode, Goose, Aider and Gemini CLI through a declarative file adapter; guided kits for ChatGPT, Claude, Gemini, Grok, Perplexity, CrewAI, LangGraph, LangChain, AutoGen, Semantic Kernel, PydanticAI, Agno, Mastra, Dify, Flowise, n8n and Letta. All pass the write contract and have been tested with the real applications. The coding tools are Partial; the hosted services and frameworks are Guided because they offer no import.

## Phase 5: Advanced agent management (done)

Content addressed versions (no version when nothing changed), version comparison and restore, location comparison, duplication with a new identity, structured memory with provenance, workflow migration with imports disabled, receipts for every operation, compatibility analysis with an explained score and attention list.

## Phase 6: Developer ecosystem (done)

CLI with JSON, quiet and verbose output, dry runs, non interactive mode, approval flags and exit codes. MCP server with preview and token based execution. Adapter SDK with a contract test harness and a hand written example adapter. Claude Code plugin, OpenClaw and Hermes skills.

## Phase 7: Advanced capabilities

- Agent synchronisation: one way, previewed, merge mode (`nomad sync`). Two way sync is not implemented: it needs a three way merge base to be safe.
- Remote migration: experimental `nomad remote push` over SSH with strict host key checking. Not tested against a real remote host in this environment.
- Team management, cloud backups, shared package registry and a public adapter marketplace: evaluated and deliberately not built. They need a server, accounts and a security review, and the specification asks for them only after the local system is proven.

## Interoperability (added)

- Reads and writes `.jetpack` interchange archives (CLI `--format jetpack`, web export format choice, inspector, uploads, migrations).
- OpenClaw: supports both roster forms, `agents.list` and the keyed `agents.entries` of OpenClaw 2026.6 and later, the `agents.defaults.systemAgent.agentId` default, and workspaces placed beside a shared `agents.defaults.workspace`. When adding an agent to a keyed roster, the current default is pinned so it never changes.
- Hermes: imported jobs also carry `paused_at`, `paused_reason` and `next_run_at: null`; a job with `paused_at` reads as paused.
- Scans also honour `OPENCLAW_STATE_DIR`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR`.

## Known limitations

- Session transcripts and platform internal search indexes are not migrated.
- TOML comments in Codex `config.toml` and comments in `openclaw.json` are not preserved on merge (backups are taken). YAML comments are preserved.
- Claude Code rewrites `~/.claude.json` while running; close it before migrating user level MCP servers.

## Priors setups and ElizaOS

Written Nov 13, 2026. Priors is a credit service for agents on Robinhood Chain; Priors and its team have not been contacted and have not reviewed this work.

Tested (automated, every push):
- Key safety: wallet keys, recovery phrases and private RPC URLs are detected; folders that can hold wallet keys are never read, followed through symlinks, backed up or written; planted fake keys never appear in plans, receipts, destinations, backups or `.nomad` exports (`tests/security`, `tests/core/keymaterial.test.ts`, `tests/migration/priors.test.ts`, contract runs with `secrets`).
- Priors setups moving between Claude Code, Codex, Hermes, Cursor and Gemini CLI, including Claude Code and Hermes plugins (`tests/migration/priors.test.ts`).
- ElizaOS JSON characters: read, write, round trip, secrets dropped on parse, TypeScript characters never executed (`tests/adapters/elizaos.test.ts`, `tests/migration/elizaos.test.ts`).

Checked with real applications on Nov 13, 2026 (`scripts/verify-real-apps.sh`, read-only, no key, no funds):
- Codex CLI 0.169.0 lists the Priors servers Nomad wrote from Claude Code (`codex mcp list`), including `env_vars` forwarding and the hosted URL.
- Claude Code 2.1.323 shows the Priors servers Nomad wrote from Hermes (`claude mcp get`); the local wallet server started and connected without a key.
- `@priors/mcp` 0.20.0 starts without a key and reports "read-only tools only".
- ElizaOS 1.7.2: every character Nomad wrote (ElizaOS to ElizaOS, Claude Code to ElizaOS, the MCP character) passes `validateCharacter` from `@elizaos/core` 1.7.2.

Not verified:
- The hosted server's tool list could not be loaded from the test machine (outbound access to mcp.priors.trade was blocked), so "the hosted tool list loads" is not checked.
- ElizaOS characters were not loaded by a running agent (`elizaos start --character`); only the schema check above was done.
- Cursor and Gemini CLI were not run with the moved Priors setups. Gemini CLI's `${VAR}` expansion in settings.json is assumed.
- Claude Code plugin layout (`installed_plugins.json` shape, `enabledPlugins`) and Hermes plugin layout beyond the documented files are modeled on documentation, not on a real install.
- Whether Claude Code accepts `${VAR:-}` for every variable (only `PRIORS_AGENT_ID` is written that way), whether ElizaOS's MCP plugin expands `${VAR}`, and whether it ignores the `settings.nomadAgentId` key.
- OpenClaw (Phase 1B) is not done.

## Oak setups (added)

Written Nov 14, 2026. Oak Agent Kit is a local wallet and tools for Robinhood Chain projects. Oak and its team have not been contacted and have not reviewed this work. See [docs/guides/oak-setups.md](guides/oak-setups.md).

Tested (automated, every push):
- Oak setups moving between Claude Code, Codex, Hermes, Cursor and Gemini CLI, including Oak's Claude Code plugin, whose `.mcp.json` lists servers without an `mcpServers` wrapper (`tests/migration/oak.test.ts`).
- `~/.oak` is never read, followed through a symlink or written; wallet contents never appear in plans, receipts, destinations, backups or `.nomad` exports, with or without `--include-secrets`; sources and `~/.oak` are unchanged after every move; every move is idempotent.
- Which entries count as Oak (the `oak` command with `mcp`, `npx @oakagentkit/addon`), and that the Priors profile behaves exactly as before.

Checked with real applications on Nov 14, 2026 (Oak `@oakagentkit/addon` 0.3.8 installed in a throwaway folder, throwaway home folders, no funds):
- Oak's own `oak connect` reports "already set up, nothing was changed" for the entries Nomad wrote into Codex, Gemini CLI, Cursor and Claude Code. The same command on an empty home writes a new entry, so the check is meaningful.
- Claude Code 2.1.325 started Oak and connected for the entries Nomad wrote: `oak mcp`, the pinned `npx -y @oakagentkit/addon@0.3.8 mcp`, and the entry moved from Hermes.
- Oak's MCP server answers an MCP initialize with server `oak` 0.3.8. On first start it created a new wallet in the throwaway home, and with no system keychain available it kept the wallet's unlock key in `~/.oak`.

Not verified:
- Codex, Cursor, Gemini CLI and Hermes were not run with the moved entries (only Oak's own check above).
- Signing, approvals and anything on chain: no wallet was funded and no transaction was made. Which apps show Oak's approval form (MCP form elicitation) was not tested.
- Gemini CLI's bare `$NAME` references are read as plain text by Nomad for every server, not only Oak; `${NAME}` works. For Oak this fails safe: Oak rejects the value.

## BrainChain setups (added)

Written Nov 15, 2026. BrainChain verifies AI agent work and settles payments on Robinhood Chain and Base. This follows BrainChain's public docs and repositories; see [docs/guides/brainchain-setups.md](guides/brainchain-setups.md).

Tested (automated, every push, `tests/migration/brainchain.test.ts`):
- BrainChain setups, mostly mainnet, moving between Claude Code, Codex, Cursor, Gemini CLI, Hermes and OpenClaw: the `claude mcp add` entry, the repository's `mcp.json` paying on Base, a raw key in Codex, the global command on the testnet, references in Hermes, and OpenClaw's `openclaw mcp set` entry with both BrainChain skills.
- The preview names the network, where it pays and the limits, warns when there is no daily cap, lists the one-time approval and the wallet check, and says what the skills need off OpenClaw.
- `~/.brainchain` and `~/.config/brainchain-worker` are never read, followed through a link or written; planted keys never appear in plans, receipts, destinations, backups or `.nomad` exports, with or without `--include-secrets`; sources and those folders are unchanged after every move; every move is idempotent.
- Which entries count as BrainChain (the worker program does not), and that the Hedgehood, Oak and Priors profiles are unchanged.

Checked with real applications on Nov 15, 2026 (`brainchain-mcp` 0.9.3 and Claude Code 2.1.325 in throwaway folders, throwaway homes with fake keys, no funds, nothing paid or signed):
- BrainChain's own server, started from every entry Nomad wrote (Claude Code to Codex, Cursor, Gemini CLI and OpenClaw; Codex, Gemini CLI, Hermes and OpenClaw to Claude Code; Cursor to Gemini CLI; OpenClaw to Hermes) with the variables the preview asks for, lists its seven tools. Its task tool names the paying wallet of the fake key and the expected chain: Robinhood Chain, Base, or the Robinhood Chain testnet. The Hermes entry, whose key file was an optional reference, starts without a wallet, which the preview now says plainly.
- Claude Code connected to BrainChain for the entries Nomad wrote from Codex, Gemini CLI, Hermes and OpenClaw.

Not verified:
- Posting, grading or bonding a task, the approval and anything on chain: no wallet was funded.
- Codex, Cursor, Gemini CLI, Hermes and OpenClaw were not run with the moved entries (only BrainChain's own server and Claude Code above).
- The worker program and the skills' scripts were not run.

## OpenClaw MCP servers (added)

Written Nov 15, 2026. Nomad reads and writes OpenClaw's MCP servers in `openclaw.json` under `mcp.servers`, the block `openclaw mcp set` manages (docs.openclaw.ai/gateway/config-extensions). Before, servers moving to OpenClaw were listed for manual setup through a plugin.

- Read: local servers (command, args, env) and remote ones (url, headers; `transport` `streamable-http` or `sse`, and SSE when it is left out, as in OpenClaw). `${VAR}` values and OpenClaw secret reference objects become references; literal secrets are never kept. `enabled: false` servers are read as switched off. The servers are shared by every agent of that OpenClaw, so each agent carries them.
- Write: servers are merged into `mcp.servers` next to the ones already there, with the transport written out. Nothing with `${...}` in it is written into `openclaw.json` (OpenClaw substitutes every string there, and an older OpenClaw refuses to load a config with an unset variable): a reference, or a value that uses a variable, becomes an `openclaw config set mcp.servers.<name>.env.<VAR> <value>` step, and a server whose command line or address uses one is listed for manual setup. The preview says the servers will be shared by all agents of that OpenClaw. OpenClaw-only server settings (`toolFilter`, `codex`, `auth`, timeouts) are kept with the server and written back on OpenClaw; elsewhere a tool filter that is not carried is listed as a permissions item, and an OAuth sign-in as a step (sign-ins and OAuth overrides are never copied). The `codex` block only affects Codex app-server threads in OpenClaw, so every OpenClaw agent carries every enabled server.

Tested (automated, `tests/migration/openclaw-mcp.test.ts`): reading every form above; OpenClaw to Claude Code; Claude Code to OpenClaw next to an existing server, with no `${` in the written file, the steps, verification and a second move that changes nothing; OpenClaw to OpenClaw with a switched-off server left behind; no secret value in any destination; source unchanged.

Checked with the real application on Nov 15, 2026 (OpenClaw 2026.11.3 in a throwaway folder and home): a file Nomad wrote (Claude Code to OpenClaw, next to an existing server) is listed by `openclaw mcp list` and `openclaw mcp status` with every server `ok` and the right transport, the `openclaw config set` steps from the preview work as written, and `openclaw config validate` reports the config as valid. Nomad then read the file back after OpenClaw rewrote it: all four servers, with the values set through `openclaw config set` turned into references and not shown anywhere.

Not verified: OpenClaw agents were not run, so no server was started from OpenClaw.

## Hedgehood setups (added)

Written Nov 15, 2026. Hedgehood is an options market for AI agents on Robinhood Chain. Hedgehood and its team have not been contacted and have not reviewed this work. See [docs/guides/hedgehood-setups.md](guides/hedgehood-setups.md).

Tested (automated, every push):
- Hedgehood setups, mostly mainnet, moving between Claude Code, Codex, Hermes, Cursor and Gemini CLI, including Hedgehood's Claude Code plugin, whose server is declared in `plugin.json` and whose skill is listed by its own folder (`tests/migration/hedgehood.test.ts`).
- `~/.hedgehood` is never read, followed through a symlink or written; planted keys never appear in plans, receipts, destinations, backups or `.nomad` exports, with or without `--include-secrets`; raw keys in an entry are written only as references, even with `--include-secrets`; sources and `~/.hedgehood` are unchanged after every move; every move is idempotent.
- Which entries count as Hedgehood, and that the Oak and Priors profiles are unchanged.

Checked with real applications on Nov 15, 2026 (`@hedgehood-io/mcp` 0.5.1 installed in a throwaway folder, throwaway home folders with fake keys, no funds, nothing signed):
- Hedgehood's own `hedgehood-mcp --check` on every entry Nomad wrote (Codex to Claude Code and Gemini CLI, Claude Code to Codex and Cursor, Gemini CLI to Claude Code, Hermes to Claude Code) resolves mainnet (4663), the owner account, the session key from Hedgehood's folder, no owner key, and the settings carried (dry run off and a 50 USDG cap where the source set them; otherwise Hedgehood's defaults). The same entry on a computer without `~/.hedgehood` stops with "no account", so the check is meaningful.
- Claude Code 2.1.325 started Hedgehood and connected for the entries Nomad wrote from Codex, Gemini CLI and Hermes, including with the session key variable unset (Hedgehood then uses its settings file).

Not verified:
- Trading, quotes, deposits and anything on chain: no account was funded and no session was authorized.
- Codex, Cursor, Gemini CLI and Hermes were not run with the moved entries (only Hedgehood's own check above).
- The hosted read-only servers were not contacted.

## HEY Research setups (added)

Written Nov 16, 2026. HEY Research Lab is read-only research on Robinhood Chain projects. HEY Research Lab and its team have not been contacted and have not reviewed this work. See [docs/guides/hey-research-setups.md](guides/hey-research-setups.md).

Tested (automated, every push):
- HEY setups moving between Claude Code, Codex, Gemini CLI, Hermes and OpenClaw: the hosted server and research profile, the `x-hey-integration` header, the local server with its pin and profile, and the global command (`tests/migration/hey.test.ts`). API keys, in a header or in `HEY_API_KEY`, never appear in destinations, plans, receipts or Nomad's library; sources are unchanged; OpenClaw's file never gets a `${...}` value.
- Which entries count as HEY: its real addresses, package and command, and 12 look-alikes that do not (other hosts, http, other ports and paths, similar package and command names).

Checked with real applications on Nov 16, 2026: Codex CLI 0.169.0, Gemini CLI 0.68.0 and OpenClaw 2026.9.2 and 2026.11.4 list the moved hosted research profile and the pinned local server with its profile (`scripts/check-real-apps.mjs`). HEY's hosted server answered with 14 tools and its research profile with 8; the local package 0.3.5 listed 13 tools, and 8 with `HEY_MCP_PROFILE=research`, without a key (`scripts/check-hey-servers.mjs`). The Real apps workflow repeats both every week.

Not verified: research answers themselves, and anything with an API key (none was used).

## Rushr setups and Codex plugins (added)

Written Nov 16, 2026. Rushr is a social trading terminal for humans and AI agents on Robinhood Chain. Rushr's team pointed us to its documentation and has not reviewed this work. See [docs/guides/rushr-setups.md](guides/rushr-setups.md).

Tested (automated, every push):
- Rushr setups moving between Claude Code, Codex, Gemini CLI, Hermes, Cursor and OpenClaw, including Rushr's Claude Code and Codex plugins (`tests/migration/rushr.test.ts`): real money or dry run named with the caps, dry run as a reference flagged, limits carried only as values, both wallet settings written as neither, raw keys written only as references even with `--include-secrets`, `~/.rushr` and wallet files (`agent-wallet.json`, `.agent-wallet.json`) never read, followed or written, and planted keys never in plans, receipts, destinations, backups or exports.
- Installed Codex plugins: read from `config.toml` and Codex's plugin folder, disabled ones skipped, a plugin folder leading outside Codex's plugin folder refused; another Codex gets the install commands, other apps get ordinary entries.
- Which entries count as Rushr, and look-alikes that do not.
- The short preview (the default) now shows warnings, such as a moved server trading real money; before, they appeared only with `--details`.

Checked with real applications on Nov 16, 2026 (`scripts/check-rushr.mjs`, throwaway homes): Codex CLI 0.169.0 installed Rushr's plugin (`codex plugin add rushr@rushr`); Nomad read it and moved it to Gemini CLI 0.68.0, which lists the server as its own, and to another Codex, where Nomad copied nothing and following its printed install commands brought the plugin back. The Real apps workflow repeats this weekly and also starts `@rushr/mcp` 0.1.2 in dry run with no wallet to check it lists its tools and makes no wallet.

Not verified: trading, registration, callouts and anything on chain (no wallet was funded).

## QHooks setups (added)

Written Nov 16, 2026. QHooks is a launchpad and trading terminal built on Uniswap v4, reached through a hosted, keyless MCP server; the user's wallet signs everything it prepares. The QHooks team asked Nomad to add its server and has not yet reviewed this work. See [docs/guides/qhooks-setups.md](guides/qhooks-setups.md).

Tested (automated, every push):
- QHooks setups moving between Claude Code, Codex, Gemini CLI and OpenClaw (`tests/migration/qhooks.test.ts`): `?ref=nomad` added to an address that names no referral, a user's own `ref` (even an empty one) left exactly as it is, the rest of the address kept as written, and the source unchanged.
- The referral note: the `qhooks-referral` skill where the destination has skills, a section in the instructions where it does not (Gemini CLI), added once and never doubled on later moves, and left out when skills and instructions are not moved or the user has their own referral.
- Which entries count as QHooks, and 10 look-alikes that do not (http, other hosts, `www.qhooks.com`, other ports and paths, a user name in the address), which get no referral and no notes.

Checked with real applications: the Real apps workflow moves QHooks to Codex CLI, Gemini CLI and OpenClaw and checks each lists `https://qhooks.com/mcp?ref=nomad` and has the referral note (`scripts/check-real-apps.mjs`), and that QHooks' server answers at that address with its tools, `prepare_trade` and `prepare_launch` taking a referrer (`scripts/check-qhooks.mjs`). For information it also asks for an unsigned sample trade with and without Nomad's referrer. On Nov 16, 2026 QHooks' server listed 31 tools; the sample trade named Nomad's referrer when the referrer was passed (as the referral note asks) and did not when only the `?ref=nomad` address was used.

Not verified: trades and launches themselves (nothing was signed), and the referral payouts.

## Your Nomad (added)

Written Nov 18, 2026. One home for all of a person's agents, reachable from inside their apps: show, gather, borrow, bring and send back, through six new MCP tools (`show_agents`, `gather_agents`, `borrow_agent`, `bring_agent`, `send_back`, `apply_send_back`), `nomad home` and `nomad connect` in the CLI, and a Your Nomad page in the dashboard. See [docs/guides/your-nomad.md](guides/your-nomad.md).

Tested (automated, every push, `tests/home/`):
- Show and gather: agents found in apps before and after gathering, nothing in the apps changed, no duplicates when gathering again, copies marked behind after a newer home version.
- Borrow: persona, rules, memory and skills as text, skill steps and memory searches on request, the length limit, secrets left out, nothing written (versions, operations and app files unchanged), agents from packages marked as made by others.
- Send back: new notes added after an approved preview only, duplicates skipped, secrets redacted, an entry changed only in the chat updated, changed in both places refused until chosen, an older chat never undoing a newer home, a preview refused once the home changed, changes read from a Claude Code copy without touching it, nothing deleted, skills and tools only when asked, a copy of another agent refused.
- `nomad connect` in a home with Claude Code, Codex, OpenClaw and Hermes: the preview writes nothing; each entry is added with every other setting unchanged; Codex's TOML and Hermes' YAML keep their text exactly and come back to the same bytes on removal; OpenClaw's and Gemini CLI's files with comments are left alone, with the app's own command instead (`openclaw mcp set`, `gemini mcp add`; Gemini's was run here and kept the comments); a `nomad` skill Nomad did not write is never replaced and an edited one is kept on removal; files it cannot edit safely are left alone; a backup undoes it.
- The MCP tools through an MCP client, the CLI commands, and the dashboard API.
- Markers (`tests/security/markers.test.ts`): ids and titles holding `-->`, quotes or line breaks read back exactly and move to Claude Code, Codex, OpenClaw and Hermes with every entry intact (before the fix, Claude Code lost a rule and a memory entry).
- Security (`tests/home/security.test.ts`): secrets in titles and text redacted before a send back is shown or saved; Nomad's markers removed, and broken ones refused; ids, titles and sizes checked; the connect preview never shows other settings; a `nomad` server Nomad did not add is left alone on removal; a skill changed after the preview is not deleted.

Checked with real applications: `scripts/check-your-nomad.mjs` (Real apps workflow) connects Nomad to the real Codex CLI, Gemini CLI and OpenClaw, checks each lists the server as written, starts the server with the command written for Codex and calls its tools, then removes it. Run here with Codex CLI and Gemini CLI, which passed; OpenClaw needs Node 24, which the workflow has. The real Claude Code was checked by hand: `claude mcp list` connects to the server `nomad connect` wrote.

Not verified: a model in each app choosing the tools from a spoken request (no model sign-in in the build environment).

## Stoa setups (added)

Written Nov 18, 2026. Stoa is a swap router on Robinhood Chain and Elysium, reached through a hosted, keyless, read-only MCP server whose swaps are unsigned transactions for the user's wallet. The Stoa team asked Nomad to add its server and reviewed the guide on Nov 18, 2026. See [docs/guides/stoa-setups.md](guides/stoa-setups.md).

Tested (automated, every push):
- Stoa setups moving from Claude Code to Codex and OpenClaw (`tests/migration/stoa.test.ts`): the address exactly as written (no referral added), the `stoa` skill, and the preview naming Stoa's router; the source unchanged.
- Which entries count as Stoa, and 9 look-alikes that do not, which get no note.

Checked with real applications: the Real apps workflow asks Stoa's server, with no key, for its tools and checks `list_tokens` names the routers the preview tells people to check, on Robinhood Chain and Elysium, then moves a setup to the real Codex and OpenClaw, which list the server, with the skill in OpenClaw (`scripts/check-stoa.mjs`). Nothing is built, signed or sent.

Not verified: quotes, safety checks and swaps themselves.

## Ostra setups, and Tokyo Futuro's sending (added)

Written Nov 18, 2026. Ostra is a vault of USDG for AI agents on Robinhood Chain guarded by post-quantum one-time keys, reached through a local MCP server or a hosted connector. Ostra's team reviewed the guide and Nomad's Ostra support on Nov 18, 2026, and ran a real move from Claude Code to Codex with a live vault (commit 698eca8): the same vault opened on mainnet before and after, the seed folder was untouched, and no seed, fee payer key or keyed RPC URL was in anything Nomad wrote or keeps. See [docs/guides/ostra-setups.md](guides/ostra-setups.md).

Tested (automated, every push):
- Ostra setups moving from Claude Code to Codex and OpenClaw, and from an agent folder to OpenClaw (`tests/migration/ostra.test.ts`): the local server with its pin, the hosted connector as its address with a sign-in step, a keyed RPC as a reference (and as a value only with `--include-secrets`), `off` and public RPCs as values, the one-place-at-a-time warning and the backup steps for another computer.
- The seed folder (`~/.ostra`: `master.key`, `fee-payer.key`, `wots/`) and seed backup files are key material, never read; a planted seed and backup never appear in destinations, plans, receipts or Nomad's library. A backup pasted into notes is removed.
- Another deployment record, other service addresses, a prover and an RPC file each get their warning or step; Ostra's package, command and connector are recognised, and 10 look-alikes are not.
- Tokyo Futuro's `tokyo-futuro-mcp` 0.2.0 can send with `TOKYO_ALLOW_SEND=1`: the preview now says when sending is off, warns when it is on with its approval cap, and carries the cap only as a value.

Checked with real applications: the Real apps workflow starts `@ostraagent/mcp` 0.1.24 in a throwaway vault folder with Ostra's services off and lists its tools, checks the hosted connector answers, and moves a setup with a planted seed and backup to the real Codex and OpenClaw, which list the servers, with the seed, backup and RPC key nowhere in what Nomad wrote (`scripts/check-ostra.mjs`). `scripts/check-tokyo.mjs` now checks `tokyo-futuro-mcp` 0.2.0 and its new tools.

Not verified: a real vault, funds, payments and the backup round trip (no vault was funded).

## Tokyo Futuro setups and .mcp.json in agent folders (added)

Written Nov 17, 2026. Tokyo Futuro is an onchain city game on Robinhood Chain where agents take jobs, join crews and bet, through a hosted server or a local one that signs in with the agent's wallet. The Tokyo Futuro team asked Nomad to add its servers and has not yet reviewed this work. See [docs/guides/tokyo-futuro-setups.md](guides/tokyo-futuro-setups.md).

Tested (automated, every push):
- Tokyo setups moving from Claude Code to Codex and Claude Code, and an agent exported as a folder (persona, rules, notes, the `tokyo-futuro` skill and `.mcp.json`) moving into OpenClaw (`tests/migration/tokyo.test.ts`): the hosted server, the local server with its pin, `TOKYO_URL`, `AGENT_NAME` and `AGENT_ERC8004_ID` carried as values, `AGENT_KEY` written only as a reference even with `--include-secrets`, and planted keys and sign-in tokens never in destinations, plans, receipts or Nomad's library. Sources are unchanged.
- Tokyo's sign-in token (`<wallet>.<expiry>.<epoch>.<hmac>`) is a secret rule of its own: it is removed from notes and other text, while wallet addresses and job ids are left alone.
- `TOKYO_URL` pointing elsewhere warns; the testnet, a reference or no address each get their own note; the global command and the one-file script get install steps.
- Which entries count as Tokyo Futuro, and 12 look-alikes that do not.
- Agent folders read MCP servers from `.mcp.json`. A folder is often one someone else sent, so its local servers are shown and need the `run-commands` approval, as for packages; without it nothing is written.

Checked with real applications: the Real apps workflow lists the tools of Tokyo's hosted server (no key, no sign-in) and of `tokyo-futuro-mcp` 0.1.2 started with no wallet key, then moves an agent folder into the real OpenClaw, which must accept its config and list the server, with the notes there and the planted token nowhere (`scripts/check-tokyo.mjs`).

Not verified: signing in, jobs, bets and anything on chain (no wallet key was used).

## Wallet keys stay out with --include-secrets (added)

Written Nov 15, 2026. With `--include-secrets`, other secrets still travel when asked, but wallet private keys and recovery phrases are left out everywhere a move, export or import writes: text, launch arguments, URLs, headers, environment values and files (including `.env` files kept with `--include-sensitive-files`). They become references, and the preview and export output say how many were left out. Without `--include-secrets` nothing changed.

Tested (automated, every push, `tests/security/wallet-keys.test.ts`): which values count as wallet keys (0x keys, bare hex keys, Solana base58 and byte-array keys, recovery phrases) and which do not (API keys, a 64-character hex value under an API name, transaction hashes without key words); the sanitizer, `.nomad` exports and opening older packages that hold a wallet key; moves from Codex to Claude Code, Hermes and Cursor with `--include-secrets`, where the API key arrives and no wallet key reaches the plan, receipt, destination or backups, and the source is unchanged.

Not covered: wallet keys in formats other than those above (for example an encrypted keystore file, which is already left out as a credential file unless `--include-sensitive-files` is used, and is encrypted).

## Holder vote (removed on 25 November 2026)

- The Vote page, its API, the suggestion box and the round job were removed. Past rounds stay in `governance/rounds/` as a record.

What it was:

- Vote page at `/vote`, vote API under `/api/vote`, round job in `.github/workflows/vote-rounds.yml`, round files in `governance/`. See [governance/README.md](../governance/README.md).
- Tested: signature checks, weighting from the balance snapshot, one vote per wallet, closed and upcoming rounds, tie rules, the explorer and transfer-replay snapshots, the round job (opening, closing, recount, GitHub comments and labels), and an end-to-end run in a browser with wallets that really sign, a stand-in database and the close step recounting those votes.
- Not yet verified: the live Robinhood Chain RPC and Blockscout API (unreachable from the build environment), the connected Upstash database, and a vote from a real wallet app. The first round is the check: open it by hand and cast one test vote.
- Suggestion box on the Vote page: anyone can suggest or back an app (a few suggestions and backs per person per day, plus a hidden field that catches bots). The workflow, every 5 minutes, posts new suggestions as GitHub issues and publishes the list the site shows. Tested with unit tests and in a browser against a stand-in database.
- Smart-contract wallets (ERC-1271) cannot vote yet; votes must be signed by an ordinary wallet key.

## Zolva setups, and bearer tokens in a variable (added)

Written Nov 19, 2026. Zolva is open trading-agent infrastructure on Robinhood Chain, reached through a hosted MCP server that is read-only without a key and adds tools for an optional API key's scopes. The Zolva team asked Nomad to add its server and tested this work before release on Nov 19, 2026. See [docs/guides/zolva-setups.md](guides/zolva-setups.md).

Tested (automated, every push):
- Zolva setups moving between Claude Code, Codex, Hermes, Cursor and OpenClaw (`tests/migration/zolva.test.ts`): the address as written; a key in a header or a variable becomes `ZOLVA_KEY` holding the key alone (`bearer_token_env_var` in Codex, `Bearer ${ZOLVA_KEY}` in Claude Code and Hermes, `${env:ZOLVA_KEY}` in Cursor, a step for OpenClaw that keeps the key out of `openclaw.json`); a variable of the user's own keeps its name; a keyless setup stays keyless; a Codex round trip comes back as Zolva's docs write it. Planted keys never appear in destinations, plans, receipts or Nomad's library, and the sources are unchanged.
- Zolva's key shape (`zk_` and 43 characters) is a secret rule of its own, so a key in instructions or notes is removed.
- Which entries count as Zolva, and 9 look-alikes that do not, which get no note and keep their header as it was.
- For any remote server: Codex's `bearer_token_env_var` is read and written, a header written as `Bearer ${NAME}` keeps `NAME`, an existing Authorization header wins, and local servers never get one.

Checked with real applications: `scripts/check-zolva.mjs` (Real apps workflow) asks Zolva's server, with no key, for its seven read-only tools, checks a wrong key is refused with 401, then moves a setup with a fake key to the real Codex, which lists the server with `bearer_token_env_var = "ZOLVA_KEY"`, and OpenClaw, which accepts its config, with the key nowhere in what Nomad wrote. The Codex part was run here with Codex CLI 0.170.0 and passed. No tool is called and no account is used.

Not verified: the keyed tools with a real key (that needs a Zolva account).

## Memoria setups (added)

Written Nov 19, 2026. Memoria is a shared memory service for AI agents, reached through a hosted MCP server that needs the agent's key on every request; each key is one agent. Memoria's team reviewed this work on Nov 19, 2026. See [docs/guides/memoria-setups.md](guides/memoria-setups.md).

Tested (automated, every push):
- Memoria setups moving between Claude Code, Codex, Hermes, Cursor and OpenClaw (`tests/migration/memoria.test.ts`): the address as written; a key in a header or a variable becomes `MEMORIA_API_KEY` holding the key alone (`bearer_token_env_var` in Codex, `Bearer ${MEMORIA_API_KEY}` in Claude Code and Hermes, `${env:MEMORIA_API_KEY}` in Cursor, a step for OpenClaw that keeps the key out of `openclaw.json`); a variable of the user's own keeps its name; a setup with no key gets a step saying Memoria refuses it; a Codex round trip and a `.nomad` package keep the variable. Planted keys never appear in destinations, plans, receipts or Nomad's library, and the sources are unchanged.
- Memoria's key shape (`mem_`, 12 hex characters and 43 more) is a secret rule of its own, so a key in instructions or notes is removed, while memory ids (`mem-1a2b3c4d`) are left alone.
- Which entries count as Memoria, and 10 look-alikes that do not (a Memoria on this computer included), which get no note and keep their header as it was.

Checked with real applications: `scripts/check-memoria.mjs` (Real apps workflow) sends Memoria's server one request with no key and checks it is refused with 401, then moves a setup with a fake key to the real Codex, which lists the server with `bearer_token_env_var = "MEMORIA_API_KEY"`, and OpenClaw, which accepts its config, with the key nowhere in what Nomad wrote. No key is sent and no account is used.

Not verified: saving and finding memories with a real key (that needs a Memoria account).

## Upoch setups (removed on 28 November 2026)

Nomad no longer recognizes Upoch setups: an Upoch server moves like any other local server, without Upoch's notes.

## OddsEngine setups (added)

Written Nov 22, 2026. OddsEngine runs crypto safety checks and AI models behind one key, through a hosted MCP server (`https://api.oddsengine.live/mcp`, "Authorization: Bearer oe_live_...", or the key in the address as `/mcp/k/<key>`), paid per call from the account's balance (OddsEngine also offers keyless pay-per-call use, which Nomad moves as it is). This follows what OddsEngine's team described to Nomad on Nov 22, 2026, and OddsEngine's team reviewed it the same day. See [docs/guides/oddsengine-setups.md](guides/oddsengine-setups.md).

Tested (automated, every push):
- OddsEngine setups moving between Claude Code, Codex, Cursor and OpenClaw (`tests/migration/oddsengine.test.ts`): a key in the header becomes `ODDSENGINE_API_KEY` holding the key alone (`bearer_token_env_var` in Codex, `Bearer ${ODDSENGINE_API_KEY}` in Claude Code, `${env:ODDSENGINE_API_KEY}` in Cursor, a step for OpenClaw that keeps the key out of `openclaw.json`); a key in the address is taken out, and the plain address with the variable arrives; a key kept on purpose (`--include-secrets`) stays, with a warning when it is in the address; a setup with no key gets a step with Nomad's link; the preview names OddsEngine and links to `engine.oddsengine.live/?ref=nomad`. Planted keys never appear in destinations, plans, receipts, Nomad's library or a `.nomad` package, and the sources are unchanged.
- The `oddsengine-credit` skill (an instruction where the app has no skills) is added once, only with an enabled OddsEngine server and only when skills or instructions move, and never doubled on a round trip.
- OddsEngine's key shape (`oe_live_` and the key) is a secret rule of its own, found in text and in addresses.
- Which entries count as OddsEngine, and 11 look-alikes that do not, which get no note.

Checked with real applications: `scripts/check-oddsengine.mjs` (Real apps workflow) checks that OddsEngine's server answers and refuses a tool call with no key, then moves a setup with a fake key in its address to the real Codex and OpenClaw, with the key nowhere in what Nomad wrote.

Not verified: OddsEngine's tools with a real key through a moved setup (Nomad AI calls `scan_token` with a real key outside Nomad).

## Bull setups (added, in 0.7.8)

Written Nov 26, 2026. Bull runs agreements between agents on Robinhood Chain, through a hosted MCP server (`https://www.bull.family/api/mcp`, no key) or a local one that signs with `BULL_AGENT_KEY`. See [docs/guides/bull-setups.md](guides/bull-setups.md).

Tested (automated, every push):
- Bull setups moving from Claude Code to Codex and to OpenClaw (`tests/migration/bull.test.ts`): the hosted address arrives exactly; the local server arrives without its key, which is never written; a local server with no key gets a note that it can only plan; look-alikes get no notes.
- Bounty prizes through Bull's arbiter escrow (`tests/web/bounties.test.ts`): Bull's plan is used only when every field is what Nomad asked for, a lock is recorded only once read on chain from Bull's own contract, and an expired lock can be made again.
- Sponsors' bounties (`tests/web/bounty-sponsors.test.ts`): only accounts in BOUNTY_SPONSORS can post; each draft is signed field by field and checked by Venin; the whole prize (200 USDG unless set) is shared equally by at least 5 winners, half from the sponsor and half from Nomad; it shows only after a team reviewer approves it (schedule kept, moved or locked) and the sponsor's half is read on chain from its own Nomad account, never also counted as credits. Agents hand in while it is open, and winners are picked only after it closes. Sponsors cannot enter their own bounty, can pick its winners, and cannot record payments; each winner is paid on its own.

Not verified: a real prize locked and released through Bull's escrow.

## Zero Lux setups and hiring (added, in 0.7.9)

Written Nov 27, 2026. Zero Lux sells one agent job per paid run in USDG, paid with a signature and no gas, through a hosted MCP server (`https://zerolux.fun/mcp`, no key). See [docs/guides/zerolux-setups.md](guides/zerolux-setups.md).

Tested (automated, every push):
- Zero Lux setups moving from Claude Code to Codex (`tests/migration/zerolux.test.ts`): the address arrives exactly, with a note on paying; look-alikes get no notes.
- Hiring by agents on Nomad (`tests/web/zerolux.test.ts`): only live version 4 agents (refundable, receive-form payments) are listed; the payment is signed for exactly the listed price, to the listed wallet, in the receive form; nothing is signed when the terms or the wallet differ from the listing, or when Zero Lux's API names a factory other than the one Nomad pins; a slow run is collected on the next run; creators choose the limits and hiring is off until they do; each hire is taken from credits first, given back when it fails, and stops at the creator's number a day, two a run, or short credits.
- The status check (`/api/agents/status?check=zerolux`): lists the agents Nomad would hire, compares Zero Lux's factory with the pinned one, checks the most-used agent's wallet on chain and the payment wallet's USDG. It asks for no run and signs nothing.

Checked by hand (Nov 27, 2026): Zero Lux's five tools answer with no key, and a setup moves correctly to Claude Code, Codex, Gemini CLI and Cursor.

Not verified: a real hire by a hosted agent in production.

## Autonomo setups (added, in 0.7.9)

Written Nov 27, 2026. Autonomo runs a local MCP server (`npx -y autonomo-mcp`) that pays gateways from the agent's wallet, within spending limits set in its environment. See [docs/guides/autonomo-setups.md](guides/autonomo-setups.md).

Tested (automated, every push):
- Autonomo setups moving from Claude Code to Codex, OpenClaw and Cursor (`tests/migration/autonomo.test.ts`): the server and its limits move, the wallet key arrives only as a reference and is never written, and Autonomo's skill moves with its note; with no limits set the preview says the defaults apply; a Windows entry (`cmd /c npx`) moves as it is, with a step for Mac and Linux; a base address other than autonomo.fun gets a warning.

Not verified: a real payment through a moved setup.

## Kudo setups (added)

Written Nov 27, 2026. Kudo records promises between agents as covenant NFTs on Robinhood Chain, through a local MCP server (`npx -y @kudo-dev/mcp`, signing with `KUDO_PRIVATE_KEY`, or in a Phala TEE with a key from dstack), a `kudo` skill that signs with `cast`, and an ElizaOS plugin (`@kudo-dev/plugin-kudo`). See [docs/guides/kudo-setups.md](guides/kudo-setups.md).

Tested (automated, every push):
- Kudo setups moving from Claude Code to Codex, OpenClaw and Cursor (`tests/migration/kudo.test.ts`): the server and `KUDO_AGENT_ID` move, the wallet key arrives only as a reference and is never written, with a step to set the same wallet's key; the `kudo` skill and its files move with a note on `cast` and `PRIVATE_KEY`; `KUDO_KEY_SOURCE=dstack` moves as a setting with a warning that the key stays in its enclave; a setup with no key says its writes return unsigned transactions; an RPC other than Robinhood Chain's public one gets a warning that shows only its host; look-alikes are not Kudo.
- `KUDO_KEY_SOURCE` is kept as a setting only when it says `env` or `dstack`; any other value under that name is held back like a key.
- Kudo's ElizaOS plugin is known, with its key settings, and points to the MCP server on other apps.

Not verified: a covenant minted through a moved setup.

## Venin's check-up (in 0.7.5)

Written Nov 23, 2026, after the Venin x Nomad test (a planted strain survived a move; Venin's scan caught it before and after). Every move preview can now run Venin's scanner on the files it would write: planted orders need the person's `planted-orders` approval, which an assistant over MCP can never give; other findings are shown. Venin published its scanner as `@veninlab/venin` 0.1.0 (Nov 24, 2026); Nomad pins that version and loads it on every move (`NOMAD_VENIN_PACKAGE` can name another build). Checked before pinning: no install scripts or dependencies, and the WebAssembly module imports nothing but wasm-bindgen's own setup, so it cannot reach the network or files. Venin's `hidden` check (invisible characters) counts as planted orders, with `order` and `comment`. Tests: `tests/migration/venin.test.ts` and `tests/home/mcp.test.ts`; the published package runs in every CI run and finds the planted order; the native build of Venin's `scan_json` passed too.
