# Implementation status

Report per phase of the product specification. Tests: `pnpm test` (84 tests).

## Phase 1: Core portability engine (done)

Implemented: UAF schema with Zod and generated JSON Schema, versioning and upgrade hook, ULID identity, `.nomad` format 2 (compact Markdown layout) with SHA-256 integrity and Ed25519 signing, legacy `.agentpack` reading, guided `nomad` and one-line `nomad move`, hardened ZIP reader, secret scanning and redaction, adapter contract, generic folder adapter, export, import, validation, migration reports.

Tested: exact round trips, tampering, traversal, absolute paths, backslashes, symlinks, duplicates, decompression bombs, unknown file types, malformed manifests, newer schema versions, unknown extensions, secret detection and redaction, no empty files.

## Phase 2: Platform adapters (done, partial support)

OpenClaw, Claude Code, Codex and Hermes read and write, each with a capability matrix and documented limitations. All four pass the adapter contract against fixtures modelled on the documented layouts.

Verified with real applications (`scripts/verify-real-apps.sh`): Codex CLI accepts the generated `config.toml` and lists migrated MCP servers; Claude Code shows migrated MCP servers from `~/.claude.json`.

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
- Write: servers are merged into `mcp.servers` next to the ones already there, with the transport written out. Nothing with `${...}` in it is written into `openclaw.json` (OpenClaw substitutes every string there, and an older OpenClaw refuses to load a config with an unset variable): a reference, or a value that uses a variable, becomes an `openclaw config set mcp.servers.<name>.env.<VAR> <value>` step, and a server whose command line or address uses one is listed for manual setup. The preview says the servers will be shared by all agents of that OpenClaw.

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

## Wallet keys stay out with --include-secrets (added)

Written Nov 15, 2026. With `--include-secrets`, other secrets still travel when asked, but wallet private keys and recovery phrases are left out everywhere a move, export or import writes: text, launch arguments, URLs, headers, environment values and files (including `.env` files kept with `--include-sensitive-files`). They become references, and the preview and export output say how many were left out. Without `--include-secrets` nothing changed.

Tested (automated, every push, `tests/security/wallet-keys.test.ts`): which values count as wallet keys (0x keys, bare hex keys, Solana base58 and byte-array keys, recovery phrases) and which do not (API keys, a 64-character hex value under an API name, transaction hashes without key words); the sanitizer, `.nomad` exports and opening older packages that hold a wallet key; moves from Codex to Claude Code, Hermes and Cursor with `--include-secrets`, where the API key arrives and no wallet key reaches the plan, receipt, destination or backups, and the source is unchanged.

Not covered: wallet keys in formats other than those above (for example an encrypted keystore file, which is already left out as a credential file unless `--include-sensitive-files` is used, and is encrypted).

## Holder vote (added)

- Vote page at `/vote`, vote API under `/api/vote`, round job in `.github/workflows/vote-rounds.yml`, round files in `governance/`. See [governance/README.md](../governance/README.md).
- Tested: signature checks, weighting from the balance snapshot, one vote per wallet, closed and upcoming rounds, tie rules, the explorer and transfer-replay snapshots, the round job (opening, closing, recount, GitHub comments and labels), and an end-to-end run in a browser with wallets that really sign, a stand-in database and the close step recounting those votes.
- Not yet verified: the live Robinhood Chain RPC and Blockscout API (unreachable from the build environment), the connected Upstash database, and a vote from a real wallet app. The first round is the check: open it by hand and cast one test vote.
- Suggestion box on the Vote page: anyone can suggest or back an app (a few suggestions and backs per person per day, plus a hidden field that catches bots). The workflow, every 5 minutes, posts new suggestions as GitHub issues and publishes the list the site shows. Tested with unit tests and in a browser against a stand-in database.
- Smart-contract wallets (ERC-1271) cannot vote yet; votes must be signed by an ordinary wallet key.
