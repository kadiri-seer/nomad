# Nomad

Nomad moves AI agents between platforms without losing who they are. It reads an agent's identity, instructions, memory, skills, tools, routines and permissions into one portable format, shows exactly what will transfer before touching a file, writes the destination as a transaction with a backup, verifies the result and keeps a receipt.

It runs entirely on your machine. There is no account and nothing is uploaded.

Website: [nomad-iota-six.vercel.app](https://nomad-iota-six.vercel.app) · X: [@thenomadlabs](https://x.com/thenomadlabs)

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
| OpenClaw | Partial | Workspaces (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, memory/), skills, cron jobs, per agent model and tool deny lists, and MCP servers under `mcp.servers` (secret values are set with `openclaw config set`). |
| Claude Code | Partial | CLAUDE.md, subagents, skills, slash commands, settings.json permissions and model, MCP servers (user and project). No scheduler. |
| Codex CLI | Partial | AGENTS.md, config.toml (model, approval policy, sandbox, network, MCP), skills, custom prompts. One agent per home. |
| Hermes Agent | Partial | SOUL.md, MEMORY.md and USER.md entries, skills, config.yaml (model, MCP, command allowlist), cron jobs, profiles. |
| Agent folder | Full | Unpacked `.nomad` (lossless) or any folder of Markdown agent files. |
| ElizaOS | Partial (in progress) | JSON character files: bio, system, style, knowledge, plugins by name, MCP servers under `settings.mcp`. Secrets are never read. ElizaOS adapter: in progress, nothing is labelled supported until it ships and has been tested. |
| Cursor, Windsurf, Cline, Roo Code, Continue, OpenCode, Goose, Aider, Gemini CLI | Partial | Rules files and MCP configuration where the platform has one. Routines, model choice and permissions stay in the application. |
| ChatGPT, Claude, Gemini, Grok, Perplexity, CrewAI, LangGraph, LangChain, AutoGen, Semantic Kernel, PydanticAI, Agno, Mastra, Dify, Flowise, n8n, Letta | Guided | Nomad writes a setup kit (text sized for each field, starter code, memory items, steps). Nothing is sent to those services. |

`nomad adapters --platform <id>` prints the per category capability matrix. Nothing is labelled full unless it is.

We are exploring Priors setups: moving the Priors MCP servers and Hermes plugin settings between agents, with keys and limits shown as things you set again. Priors is a credit service for agents on Robinhood Chain. See [docs/guides/priors-setups.md](docs/guides/priors-setups.md). Wallet keys, key files and wallet state are never read or copied ([security model](docs/security/model.md)).

Oak setups move the same way: the Oak MCP entry (`oak mcp`, `npx @oakagentkit/addon`, or Oak's Claude Code plugin) arrives in the destination's own format, and `~/.oak`, where Oak keeps its wallet, is never read. Oak Agent Kit is a local wallet and tools for Robinhood Chain projects. See [docs/guides/oak-setups.md](docs/guides/oak-setups.md).

Hedgehood setups move too: the local server (`npx @hedgehood-io/mcp` or `hedgehood-mcp`), the hosted read-only server and Hedgehood's Claude Code plugin arrive in each destination's format, with the network named in the preview (mainnet 4663 uses real USDG). Key files and `~/.hedgehood` are never read, and raw keys are never written as values. Hedgehood is an options market for AI agents on Robinhood Chain. See [docs/guides/hedgehood-setups.md](docs/guides/hedgehood-setups.md).

BrainChain setups move too: the local server (`npx brainchain-mcp` or `brainchain-mcp`) and the BrainChain skills arrive in each destination's format, including OpenClaw, with the preview naming the network, where it pays and the limits (mainnet pays in real USDG or USDC). Key files and `~/.brainchain` are never read, and raw keys are never written as values. BrainChain verifies AI agent work and settles payments on Robinhood Chain and Base. See [docs/guides/brainchain-setups.md](docs/guides/brainchain-setups.md).

HEY Research setups move too: the hosted server (`https://heyresearch.xyz/mcp`), its research profile and the local server (`npx @hey-research-lab/mcp` or `hey-research-mcp`) arrive in each destination's format with their version pin and profile. API keys are never copied, and the preview warns when the local server reads another address than heyresearch.xyz. HEY Research Lab is read-only research on Robinhood Chain projects. See [docs/guides/hey-research-setups.md](docs/guides/hey-research-setups.md).

Rushr setups move too: the local server (`npx @rushr/mcp` or `rushr-mcp`), the `rushr` skill and Rushr's plugin for Claude Code and Codex arrive in each destination's format, with the preview saying whether each server trades real ETH (and its caps) or is in dry run. `~/.rushr` and wallet files are never read, and raw keys are never written as values. Rushr is a social trading terminal for humans and AI agents on Robinhood Chain. See [docs/guides/rushr-setups.md](docs/guides/rushr-setups.md).

Installed Codex plugins are read too: their servers and skills move to other apps as ordinary entries, and another Codex gets the plugin's install commands.

Packages: a `.nomad` file is a small ZIP of plain Markdown and JSON (`nomad.json`, `AGENTS.md`, `SOUL.md`, `MEMORY.md`, `skills/`, `routines/`, `tools.json`) with a SHA-256 for every file. Add `--sign` to sign it with your own Ed25519 key; whoever opens it sees whether it came from you, someone they trust or an unknown key, and any change after signing is reported (`nomad keys`, `nomad trust <file> --name <who>`). Older `.agentpack` files still open. Nomad also reads and writes `.jetpack` interchange archives, the flat layout other agent portability tools use (`nomad export <agent> --format jetpack`, and any `.jetpack` works wherever a package is accepted). Parts that layout has no place for, such as MCP tools, travel in a namespaced manifest key that other readers ignore.

## Install

One line, nothing to install first (no Node.js, no admin rights). After that, open Nomad from the Start menu, Applications or your apps menu like any app.

```
# Windows, in PowerShell
irm https://www.thenomad.website/install.ps1 | iex

# Mac and Linux, in Terminal
curl -fsSL https://www.thenomad.website/install.sh | sh
```

The installer downloads the bundle for your system from this repository's GitHub releases, checks it against the release's `SHA256SUMS`, and installs it in your user folder. Update with `nomad update` (or Settings > Updates in the dashboard); remove with `nomad uninstall` (or Settings > Apps on Windows). Your library in `~/.nomad` is kept unless you ask to delete it. Read the scripts first: [install.ps1](scripts/install/install.ps1), [install.sh](scripts/install/install.sh).

With Node.js 22 or newer you can also use npm:

```
npx thenomad          # start, nothing to install first
npx thenomad ui       # the dashboard in your browser
npm install -g thenomad   # optional: then just type nomad
```

`nomad ui` serves the dashboard from 127.0.0.1 with a one time session token; only your machine can reach it. Data lives in `~/.nomad` (override with `NOMAD_HOME`).

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

From GitHub, no terminal needed: add an npm access token as the repository secret `NPM_TOKEN`, then open Actions, choose "Publish to npm" and press Run workflow.

From a terminal:

```
pnpm release:npm              # builds release/npm with a clean package.json (name: thenomad)
cd release/npm
npm publish --access public
```

Pass another name if needed: `node scripts/prepare-npm.mjs nomad-agent`. Bump `version` in `apps/cli/package.json` before each new release.

When "Publish to npm" succeeds, the "Installers" workflow builds a bundle for Windows, Mac and Linux (x64 and arm64), installs and removes each one with the real installer on its own system, and publishes them as the GitHub release `v<version>`, which is where the one-line installers download from. Each bundle carries signed build provenance: `gh attestation verify <file> -R kadiri-seer/nomad`.

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
pnpm build:ui      # export the dashboard, then: pnpm nomad ui
pnpm nomad ui --dev   # dashboard with live reload
scripts/verify-real-apps.sh   # check output with real Codex / Claude Code binaries
node scripts/check-real-apps.mjs   # check output with real Codex CLI, Gemini CLI and OpenClaw (on PATH)
```

## Documentation

- [Architecture](docs/architecture/overview.md)
- [Universal Agent Format](docs/format/uaf.md)
- [Building an adapter](docs/adapters/building-an-adapter.md)
- [Security model](docs/security/model.md)
- [Migration guide](docs/guides/migrating.md)
- [Implementation status](docs/STATUS.md)
- [Token and builder bounties](docs/token.md)

## License

MIT
