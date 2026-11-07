# Architecture

Nomad is a TypeScript monorepo. One engine (`@nomad/migration`) is used by the CLI, the web app and the MCP server, so there is exactly one implementation of migration logic.

```
            CLI            Web app (local API)        MCP server
              \                  |                     /
               +----------- @nomad/migration ---------+
               |   plan / execute / verify / backup    |
               |   restore / compare / sync / export   |
               +---------------------------------------+
                 |        |          |          |
            adapters  compatibility  archive   storage
                 |                    |          |
               core + schema      security    SQLite + objects
```

## Data model

`@nomad/schema` defines the Universal Agent Format (UAF) with Zod. `AgentDocument` is the in-memory form; `.agentpack` is its file serialization (`@nomad/archive`). JSON Schema is generated from the same definitions (`nomad schema`).

## Adapters

Each adapter implements the contract in `@nomad/core` (`Adapter`):

- `info`: id, support level, per category read and write capability, default locations, limitations
- `detect(root)`, `discover(root)`
- `read(root, nativeId)` returns an `AgentDocument` and the files it read
- `plan(doc, ctx)` returns the files that represent the agent at the destination, each with a write strategy, plus conversions, unsupported items and manual steps. Adapters never write.
- `readPolicy(root)` returns the destination permission policy, used to detect widening
- `verify(doc, root, nativeId)` reads the destination back and checks it

The engine owns all writing. Write strategies:

| Strategy | Behaviour |
| --- | --- |
| replace | Whole file. Merge mode keeps a different existing file unless Nomad wrote it and it is unchanged. |
| create-only | Only if missing. |
| managed-block | A marked section in a Markdown file. The rest of the file is never touched. |
| merge-json, merge-json5, merge-toml, merge-yaml | Structured deep merge. Keys the agent does not define are always preserved. YAML comments are preserved. |
| append-entries | Delimited entry lists (Hermes memory) with de-duplication. |

## Identity

Agents have a ULID. Adapters write it as a hidden marker (`<!-- nomad:begin agent=... -->`) and the store keeps a `locations` table mapping `(adapter, root, nativeId)` to the agent id, so reading an agent back anywhere recognises it.

## Change tracking

The store records the SHA-256 of every file (and managed block) Nomad writes. Before a write, the current hash is compared:

- unknown content that differs: kept in merge mode, approval `replace` needed in replace mode
- content Nomad wrote and the user edited: approval `overwrite-modified`
- content Nomad wrote and nobody touched: updated freely

Versions are content addressed: a new version is created only when the document hash changes.

## Transactions

`applyOperations` re-checks every file hash against the preview, writes each file atomically (temp file, fsync, rename), refuses symlinks below the root, and on any failure restores already written files from memory and removes created directories. A backup of every affected file is taken first, so `nomad restore` can undo a completed migration too.

## Local web app

`nomad ui` runs the Next.js app bound to 127.0.0.1 with `NOMAD_LOCAL=1` and a random token. The token is exchanged for an httpOnly, SameSite strict cookie. The API rejects requests whose Host or Origin is not local and requires a custom header on writes. Without `NOMAD_LOCAL`, the API returns 404 and the dashboard shows install instructions, so a public deployment of the site has no file access.
