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

## Holder vote (added)

- Vote page at `/vote`, vote API under `/api/vote`, round job in `.github/workflows/vote-rounds.yml`, round files in `governance/`. See [governance/README.md](../governance/README.md).
- Tested: signature checks, weighting from the balance snapshot, one vote per wallet, closed and upcoming rounds, tie rules, the explorer and transfer-replay snapshots, the round job (opening, closing, recount, GitHub comments and labels), and an end-to-end run in a browser with wallets that really sign, a stand-in database and the close step recounting those votes.
- Not yet verified: the live Robinhood Chain RPC and Blockscout API (unreachable from the build environment), the connected Upstash database, and a vote from a real wallet app. The first round is the check: open it by hand and cast one test vote.
- Smart-contract wallets (ERC-1271) cannot vote yet; votes must be signed by an ordinary wallet key.
