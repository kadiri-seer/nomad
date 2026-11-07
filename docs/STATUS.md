# Implementation status

Report per phase of the product specification. Tests: `pnpm test` (78 tests).

## Phase 1: Core portability engine (done)

Implemented: UAF schema with Zod and generated JSON Schema, versioning and upgrade hook, ULID identity, `.agentpack` layout with SHA-256 integrity, hardened ZIP reader, secret scanning and redaction, adapter contract, generic folder adapter, export, import, validation, migration reports.

Tested: exact round trips, tampering, traversal, absolute paths, backslashes, symlinks, duplicates, decompression bombs, unknown file types, malformed manifests, newer schema versions, unknown extensions, secret detection and redaction, no empty files.

## Phase 2: Platform adapters (done, partial support)

OpenClaw, Claude Code, Codex and Hermes read and write, each with a capability matrix and documented limitations. All four pass the adapter contract against fixtures modelled on the documented layouts.

Verified with real applications (`scripts/verify-real-apps.sh`): Codex CLI accepts the generated `config.toml` and lists migrated MCP servers; Claude Code shows migrated MCP servers from `~/.claude.json`.

Not verified with the real application: OpenClaw (its current release needs Node 24.16+, not available in the build environment) and Hermes (Python). Their file formats follow the official documentation; field level details of cron job stores may differ between releases, which is why they are labelled partial.

## Phase 3: Web application (done)

Landing page with a live compatibility demo, in-browser package inspector, documentation, terms, privacy, custom 404 and favicon. Local dashboard: overview with machine scan, agents, agent details, versions with comparison and restore, the ten step migration wizard, import, export with download, platform compatibility, migration history with receipts, backups with restore preview, settings. Checked at desktop and mobile widths for overflow.

## Phase 4: Expanded platforms (done, experimental)

Cursor, Windsurf, Cline, Roo Code, Continue, OpenCode, Goose, Aider and Gemini CLI through a declarative file adapter; guided kits for ChatGPT, Claude, Gemini, Grok, Perplexity, CrewAI, LangGraph, LangChain, AutoGen, Semantic Kernel, PydanticAI, Agno, Mastra, Dify, Flowise, n8n and Letta. All pass the write contract. They are labelled experimental or guided because they were not run against the real applications.

## Phase 5: Advanced agent management (done)

Content addressed versions (no version when nothing changed), version comparison and restore, location comparison, duplication with a new identity, structured memory with provenance, workflow migration with imports disabled, receipts for every operation, compatibility analysis with an explained score and attention list.

## Phase 6: Developer ecosystem (done)

CLI with JSON, quiet and verbose output, dry runs, non interactive mode, approval flags and exit codes. MCP server with preview and token based execution. Adapter SDK with a contract test harness and a hand written example adapter. Claude Code plugin, OpenClaw and Hermes skills.

## Phase 7: Advanced capabilities

- Agent synchronisation: one way, previewed, merge mode (`nomad sync`). Two way sync is not implemented: it needs a three way merge base to be safe.
- Remote migration: experimental `nomad remote push` over SSH with strict host key checking. Not tested against a real remote host in this environment.
- Team management, cloud backups, shared package registry and a public adapter marketplace: evaluated and deliberately not built. They need a server, accounts and a security review, and the specification asks for them only after the local system is proven.

## Known limitations

- Session transcripts and platform internal search indexes are not migrated.
- TOML comments in Codex `config.toml` and comments in `openclaw.json` are not preserved on merge (backups are taken). YAML comments are preserved.
- Claude Code rewrites `~/.claude.json` while running; close it before migrating user level MCP servers.
