# Nomad

Nomad moves AI agents between platforms without losing who they are. It reads an agent's identity, instructions, memory, skills, tools, routines and permissions into one portable format, shows exactly what will transfer before touching a file, writes the destination as a transaction with a backup, verifies the result and keeps a receipt.

It runs entirely on your machine. There is no account and nothing is uploaded.

```
nomad                                guided: pick an agent, pick where it goes, confirm once
nomad move openclaw claude-code      the same in one line
nomad move openclaw ./kestrel.nomad  save to a file you can share or keep
nomad move ./kestrel.nomad codex     open it somewhere else
nomad restore <backup-id>            undo
```

Every move shows a short summary first (`--details` for every file and diff, `--dry-run` to stop there) and asks one question. A backup is taken before anything is written.

## What it supports

| Platform | Support | Notes |
| --- | --- | --- |
| OpenClaw | Partial | Workspaces (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, memory/), skills, cron jobs, per agent model and tool deny lists. MCP servers need manual setup. |
| Claude Code | Partial | CLAUDE.md, subagents, skills, slash commands, settings.json permissions and model, MCP servers (user and project). No scheduler. |
| Codex CLI | Partial | AGENTS.md, config.toml (model, approval policy, sandbox, network, MCP), skills, custom prompts. One agent per home. |
| Hermes Agent | Partial | SOUL.md, MEMORY.md and USER.md entries, skills, config.yaml (model, MCP, command allowlist), cron jobs, profiles. |
| Agent folder | Full | Unpacked `.nomad` (lossless) or any folder of Markdown agent files. |
| Cursor, Windsurf, Cline, Roo Code, Continue, OpenCode, Goose, Aider, Gemini CLI | Experimental | Rules files and MCP configuration where the platform has one. |
| ChatGPT, Claude, Gemini, Grok, Perplexity, CrewAI, LangGraph, LangChain, AutoGen, Semantic Kernel, PydanticAI, Agno, Mastra, Dify, Flowise, n8n, Letta | Guided | Nomad writes a setup kit (text sized for each field, starter code, memory items, steps). Nothing is sent to those services. |

`nomad adapters --platform <id>` prints the per category capability matrix. Nothing is labelled full unless it is.

Packages: a `.nomad` file is a small ZIP of plain Markdown and JSON (`nomad.json`, `AGENTS.md`, `SOUL.md`, `MEMORY.md`, `skills/`, `routines/`, `tools.json`) with a SHA-256 for every file. Add `--sign` to sign it with your own Ed25519 key; whoever opens it sees whether it came from you, someone they trust or an unknown key, and any change after signing is reported (`nomad keys`, `nomad trust <file> --name <who>`). Older `.agentpack` files still open. Nomad also reads and writes `.jetpack` interchange archives, the flat layout other agent portability tools use (`nomad export <agent> --format jetpack`, and any `.jetpack` works wherever a package is accepted). Parts that layout has no place for, such as MCP tools, travel in a namespaced manifest key that other readers ignore.

## Install

Requires Node.js 22 or newer and pnpm.

```
git clone https://github.com/kadiri-seer/nomad
cd nomad
pnpm install
pnpm --filter @nomad/cli build
pnpm --filter @nomad/web build
alias nomad="node $PWD/apps/cli/dist/nomad.js"
nomad ui
```

`nomad ui` serves the dashboard on 127.0.0.1 with a one time session token. Data lives in `~/.nomad` (override with `NOMAD_HOME`).

## How a migration works

1. Detect the source platform and read the agent into the Universal Agent Format.
2. Validate it, scan it for secrets and redact them.
3. Ask the destination adapter what files represent the agent there.
4. Compute every file operation without writing: conflicts, merges, diffs.
5. Compare the destination permission policy before and after. Anything broader needs approval.
6. Show the preview. Nothing has changed yet.
7. On approval: lock, back up every affected file, write atomically, roll back on any failure.
8. Read the destination back and verify. Record a receipt, a version and the location mapping.

Conflict modes: `merge` keeps existing content and reports differences, `copy` creates a separate agent, `replace` overwrites the agent's configuration and needs explicit approval for anything Nomad did not write or that you edited since.

## Publishing to npm

```
pnpm release:npm              # builds release/npm with a clean package.json (name: nomad)
cd release/npm
npm publish --access public
```

Pass another name if needed: `node scripts/prepare-npm.mjs nomad-agent`. Bump `version` in `apps/cli/package.json` before each new release.

## Repository layout

```
apps/cli            nomad command line (commander), bundled with tsup
apps/web            Next.js site, package inspector and local dashboard
packages/schema     Universal Agent Format: Zod schemas, JSON Schema, versioning
packages/core       ids, hashing, adapter contract, Markdown blocks, merges, safe fs
packages/security   secret detection and redaction
packages/archive    .nomad layout, interchange archives and a hardened ZIP reader
packages/compatibility  per category compatibility and scoring
packages/adapters   platform adapters and the static catalog
packages/storage    SQLite (Drizzle) library: agents, versions, locations, receipts, backups
packages/migration  the engine: plan, execute, verify, backup, restore, compare, sync
packages/mcp        MCP server (read only unless allowed)
packages/sdk        adapter SDK, contract test harness and an example adapter
plugins             Claude Code plugin, OpenClaw and Hermes skills
docs                architecture, format, adapters, security and guides
tests               fixtures, unit, integration, end to end and CLI/MCP tests
```

## Development

```
pnpm test          # tests: schema, security, archive safety, adapters, migrations, CLI, MCP, SDK contract
pnpm typecheck
pnpm nomad scan    # run the CLI from source
pnpm dev:web       # web app in development
scripts/verify-real-apps.sh   # check output with real Codex / Claude Code binaries
```

## Documentation

- [Architecture](docs/architecture/overview.md)
- [Universal Agent Format](docs/format/uaf.md)
- [Building an adapter](docs/adapters/building-an-adapter.md)
- [Security model](docs/security/model.md)
- [Migration guide](docs/guides/migrating.md)
- [Implementation status](docs/STATUS.md)

## License

MIT
