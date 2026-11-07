# Universal Agent Format 1.0

The canonical definition is `packages/schema/src/uaf.ts`. Generate JSON Schema with `nomad schema -o schemas/`.

## Document

| Field | Meaning |
| --- | --- |
| schemaVersion | `"1.0"` |
| id | ULID, permanent across platforms |
| name, description | display name and summary |
| createdAt, updatedAt | ISO dates |
| packageVersion | integer |
| source | platform, adapter version, native id, location |
| identity | name, description, persona (Markdown), tone, emoji, avatar, extensions |
| models | preferred, provider, fallbacks, reasoningEffort |
| instructions[] | id, kind (system, agent, custom, user-context, conventions, heartbeat, bootstrap, command), title, content, source |
| memory[] | id, kind (profile, preference, fact, project, instruction, note, summary, daily-log, document), scope (user, agent, project), title, content, date, tags, source |
| skills[] | name, description, instructions, version, author, dependencies, platforms, allowedTools, installation, config, references, files[], frontmatter, invocation (auto, manual) |
| tools[] | name, kind (mcp, builtin, function), mcp (transport, command, args, url, env, headers, cwd), inputSchema, auth, permissions, enabled |
| integrations[] | name, kind, requiresAuth, config, notes |
| workflows[] | id, name, trigger (cron, interval, once, event, manual), timezone, actions (prompt, skill, script), requiredTools, dependencies, conditions, delivery, sourceEnabled, enabled |
| permissions | mode (ask, auto, read-only), rules[] (capability, effect, pattern, source), notes |
| knowledge[], files[] | referenced and embedded files |
| history[] | operations the agent went through |
| extensions | `x-<namespace>` keys for platform specific data |

Environment values in tools are either `{ "value": "..." }` or `{ "secretRef": "NAME", "redacted": true }`. Secret values are replaced by references unless an export explicitly includes secrets.

## Package

An `.agentpack` is a ZIP with `manifest.json` (format `nomad.agentpack`), and only the files the agent needs. The manifest lists every component with its path and carries a SHA-256 per file under `integrity`. See the layout in `packages/archive/src/layout.ts` and on the website under Docs, Agent format.

## Interchange archives

Nomad also reads and writes `.jetpack` archives: `jetpack.json` (schema 0.1), `AGENTS.md`, `SOUL.md`, `MEMORY.md` (lines starting with `- ` are facts), `memory/<name>.md`, `routines/<name>.json`, `skills/<name>/` and `files/`. The mapping lives in `packages/archive/src/interchange.ts`. Instructions, memory metadata, tools and integrations that the layout cannot express are stored under the `x-nomad` manifest key so a round trip through Nomad is lossless. The format has no integrity hashes, so imports report that.

## Compatibility rules

- Unknown fields are kept (`passthrough`), unknown `x-` extensions never fail validation.
- Readers upgrade older versions in `upgradeDocument`.
- A package with a newer major schema version is refused with an explicit message.
