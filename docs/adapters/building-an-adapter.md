# Building an adapter

Adapters connect Nomad to a platform. They never write files themselves: they describe the files and the engine applies them with conflict handling, backups and rollback.

## 1. Declare capabilities

```ts
import { capabilityMatrix, type Adapter } from "@nomad/sdk";

export const myAdapter: Adapter = {
  info: {
    id: "my-platform",
    displayName: "My Platform",
    category: "coding-agent",
    support: "EXPERIMENTAL",
    adapterVersion: "0.1.0",
    supportedVersions: "My Platform 2.x",
    description: "What Nomad reads and writes.",
    defaultLocations: ["~/.my-platform"],
    multiAgent: false,
    configFormats: ["Markdown", "JSON"],
    capabilities: capabilityMatrix({
      instructions: { read: "full", write: "full" },
      memory: { read: "convert", write: "convert", notes: "Written as a section of the rules file." }
    }),
    limitations: []
  },
  // ...
};
```

Every category is `full`, `convert`, `manual` or `unsupported` for reading and for writing. Be honest: the interface and the compatibility score come from these values.

## 2. Detect, discover, read

`detect(root)` returns evidence and a confidence. `discover(root)` lists agents with a `nativeId`. `read(root, nativeId)` builds an `AgentDocument` with `createDocument()` and returns the absolute paths it read. If the platform files carry a Nomad marker (`findAgentIdMarker`), set `doc.id` from it so identities survive round trips.

## 3. Plan writes

`plan(doc, ctx)` returns `files`, each with a relative `path`, `content`, `strategy`, `component` and `description`, plus `conversions`, `unsupported` and `manualSteps`. Everything you cannot write must appear in `unsupported`; nothing may be dropped silently. Use helpers:

- `renderAgentMarkdown` / `parseAgentMarkdown` for single file platforms (marked sections round trip)
- `renderMemoryMarkdown` / `parseMemoryMarkdown` for memory
- `skillToFiles` / `readSkillsTree` for Agent Skills folders
- `mcpServersFromTools` / `toolsFromMcpServers` for MCP configuration (secrets become references)
- `defineFileAdapter` builds a whole adapter from a declarative spec for rules-file platforms

Respect `ctx.mode`. If the platform holds one agent per location, return an `error` note for copy mode.

## 4. Verify

`verify(doc, root, nativeId, ctx)` reads the destination back (pass `{ agentId: doc.id }` to `read` when files can hold several agents) and returns checks. A written file is not proof of a working migration.

## 5. Test with the contract

```ts
import { runAdapterContract } from "@nomad/sdk";

const results = await runAdapterContract(myAdapter, {
  build: (home) => buildFixture(home),
  nativeId: "main",
  expect: { instructions: 1, memory: 2 }
});
expect(results.filter((r) => !r.ok)).toEqual([]);
```

The contract checks the capability declaration, detection, discovery, that reading does not modify the source, a full migration through the real engine with verification, that secrets are not written, and that re-writing the same agent changes nothing.

A complete hand written example is in `packages/sdk/examples/json-agent.ts`. Register an adapter with `registerAdapter()` and it appears in the CLI, the web app and the MCP server.
