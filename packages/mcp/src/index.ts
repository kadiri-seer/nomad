import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { COMPONENT_CATEGORIES } from "@nomad/schema";
import { NOMAD_VERSION, NomadError } from "@nomad/core";
import { expandHome, nomadHome } from "@nomad/core/node";
import { getAdapter } from "@nomad/adapters";
import { analyzeCompatibility } from "@nomad/compatibility";
import { Nomad, parseSource, type MigrationPlan } from "@nomad/migration";

export interface McpOptions {
  home?: string;
  /** Allow executing previewed migrations and restores. Off by default. */
  allowWrites?: boolean;
  /** Allow replace mode, overwriting edited files and broader permissions. Requires allowWrites. */
  allowReplace?: boolean;
}

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown) {
  const err = e as Error & { hint?: string };
  return { isError: true, content: [{ type: "text" as const, text: `${err.message}${err.hint ? `\n${err.hint}` : ""}` }] };
}

function summarizePlan(p: MigrationPlan) {
  return {
    planId: p.id,
    approvalToken: p.token,
    agent: p.agent,
    from: p.source.label,
    to: `${p.destination.displayName} at ${p.destination.root}`,
    mode: p.mode,
    score: p.compatibility.score,
    categories: p.compatibility.categories.filter((c) => c.status !== "not-applicable").map((c) => ({ category: c.label, status: c.statusLabel, items: c.items })),
    attention: p.compatibility.attention,
    files: p.operations.map((o) => ({ path: o.path, action: o.action, conflicts: o.conflicts })),
    unsupported: p.unsupported,
    conversions: p.conversions,
    widenedPermissions: p.permissions.widened,
    unenforcedRestrictions: p.permissions.unenforced,
    disabledRoutines: p.disabledRoutines,
    manualSteps: p.manualSteps,
    approvalsRequired: p.approvalsRequired,
    blocked: p.blocked
  };
}

/**
 * Nomad as an MCP server. Reading, inspecting, previewing and exporting are
 * always available. Changing files requires the server to be started with
 * --allow-writes, and an execution must quote the token of a preview, so an
 * assistant cannot write anything the user has not seen as a preview.
 */
export function createMcpServer(options: McpOptions = {}) {
  const nomad = new Nomad({ home: options.home ? resolve(options.home) : nomadHome() });
  const server = new McpServer({ name: "nomad", version: NOMAD_VERSION });
  const exportsDir = join(nomad.store.home, "exports");

  server.registerTool("list_agents", { title: "List agents", description: "Agents in the local Nomad library with their known locations.", inputSchema: {} }, async () =>
    text(nomad.listAgents().map((a) => ({ id: a.id, name: a.name, version: a.currentVersion, origin: a.sourcePlatform, skills: a.skills, memoryEntries: a.memoryEntries, locations: a.locations.map((l) => `${l.adapter}:${l.root}#${l.nativeId}`) })))
  );

  server.registerTool("list_platforms", { title: "List platforms", description: "Supported platforms, their support level and per category capabilities.", inputSchema: {} }, async () =>
    text(nomad.adapters().map((a) => ({ id: a.id, name: a.displayName, support: a.support, defaultLocations: a.defaultLocations, capabilities: a.capabilities, limitations: a.limitations })))
  );

  server.registerTool("scan_platforms", { title: "Scan this machine", description: "Find supported platforms and agents at their default locations.", inputSchema: {} }, async () => {
    try {
      return text(await nomad.scan());
    } catch (e) {
      return fail(e);
    }
  });

  const source = z.string().describe('Agent source: a library agent id or name, a platform like "openclaw" or "claude-code:~/project#main", or a path to a .nomad, .agentpack or .jetpack package');

  server.registerTool("inspect_agent", { title: "Inspect an agent", description: "Read an agent and summarise its components. Secrets are redacted.", inputSchema: { source } }, async ({ source: s }) => {
    try {
      const loaded = await nomad.loadSource(await parseSource(nomad, s));
      const d = loaded.doc;
      return text({
        id: d.id,
        name: d.name,
        platform: d.source.platform,
        persona: d.identity.persona?.slice(0, 500),
        instructions: d.instructions.map((i) => ({ id: i.id, kind: i.kind, chars: i.content.length })),
        memory: d.memory.length,
        skills: d.skills.map((x) => x.name),
        tools: d.tools.map((t) => t.name),
        workflows: d.workflows.map((w) => ({ name: w.name, trigger: w.trigger })),
        permissions: d.permissions,
        secretsRedacted: loaded.scan.findings.length,
        notes: loaded.notes.map((n) => n.message)
      });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool(
    "check_compatibility",
    { title: "Check compatibility", description: "Explain what of an agent can move to a platform, per category.", inputSchema: { source, platform: z.string().describe("Destination platform id") } },
    async ({ source: s, platform }) => {
      try {
        const loaded = await nomad.loadSource(await parseSource(nomad, s));
        return text(analyzeCompatibility(loaded.doc, loaded.sourceAdapter?.info ?? null, getAdapter(platform).info));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "export_agent",
    { title: "Export an agent", description: `Write a portable .nomad package into ${exportsDir}. Secrets are always redacted.`, inputSchema: { source } },
    async ({ source: s }) => {
      try {
        const r = await nomad.exportAgent(await parseSource(nomad, s), { outPath: exportsDir });
        return text({ path: r.path, bytes: r.bytes.length, redacted: r.sanitize.redactedText, credentialReferences: r.sanitize.strippedEnvValues.length });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "validate_package",
    { title: "Validate a package", description: "Check a .nomad, .agentpack or .jetpack package for structure, integrity and security problems.", inputSchema: { path: z.string().describe("Path to a package file") } },
    async ({ path }) => {
      try {
        const p = resolve(expandHome(path));
        if (!/\.(nomad|agentpack|jetpack)$/.test(p)) throw new NomadError("Only .nomad, .agentpack or .jetpack files can be validated.", "usage");
        const r = nomad.validatePackage(new Uint8Array(readFileSync(p)));
        return text({ ok: r.ok, name: r.doc?.name, issues: r.issues, warnings: r.warnings, secretsFound: r.scan?.findings.length ?? 0 });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "preview_migration",
    {
      title: "Preview a migration",
      description: "Plan moving an agent to a platform. Nothing is written. Show the result to the user before any execution.",
      inputSchema: {
        source,
        platform: z.string(),
        destDir: z.string().optional().describe("Destination directory; defaults to the platform's default location"),
        mode: z.enum(["merge", "copy", "replace"]).default("merge"),
        name: z.string().optional().describe("Name for copy mode"),
        components: z.array(z.enum(COMPONENT_CATEGORIES)).optional()
      }
    },
    async ({ source: s, platform, destDir, mode, name, components }) => {
      try {
        if (mode === "replace" && !options.allowReplace) throw new NomadError("Replace mode is disabled for assistants on this server.", "forbidden", "The user can run it with the Nomad CLI or web app, or start the server with --allow-replace.");
        const adapter = getAdapter(platform);
        const dest = destDir ?? adapter.info.defaultLocations[0];
        if (!dest) throw new NomadError(`destDir is required for ${adapter.info.displayName}.`, "usage");
        const plan = await nomad.plan({ source: await parseSource(nomad, s), destination: { adapter: platform, root: expandHome(dest) }, mode, targetName: name, components });
        return text(summarizePlan(plan));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "execute_migration",
    {
      title: "Execute an approved migration",
      description: "Apply a previewed migration. Only call this after the user has reviewed the preview and asked you to apply it. Requires the plan id and its approval token.",
      inputSchema: { planId: z.string(), approvalToken: z.string() }
    },
    async ({ planId, approvalToken }) => {
      try {
        if (!options.allowWrites) throw new NomadError("This Nomad MCP server is read only.", "forbidden", "Start it with --allow-writes to let assistants apply previewed migrations.");
        const plan = nomad.getPlan(planId);
        if (!plan) throw new NomadError("Unknown or expired preview.", "plan-missing");
        const sensitive = plan.approvalsRequired;
        if (sensitive.length && !options.allowReplace) {
          throw new NomadError(`This migration needs approvals an assistant cannot give here: ${sensitive.join(", ")}.`, "forbidden", "Ask the user to apply it with the Nomad CLI or web app.");
        }
        const receipt = await nomad.execute(planId, { replace: sensitive.includes("replace"), overwriteModified: sensitive.includes("overwrite-modified"), broaderPermissions: sensitive.includes("broader-permissions") }, { token: approvalToken });
        return text(receipt);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "compare_versions",
    { title: "Compare versions", description: "Compare two versions of an agent in the library.", inputSchema: { agent: z.string(), left: z.number().int(), right: z.number().int() } },
    async ({ agent, left, right }) => {
      try {
        return text(nomad.compareVersions(agent, left, right));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool("create_backup", { title: "Back up an agent", description: "Snapshot the native files of an agent at every known location into the Nomad store.", inputSchema: { agent: z.string() } }, async ({ agent }) => {
    try {
      const b = await nomad.backupAgent(agent);
      return text({ backupId: b.id, files: b.files.length });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("preview_restore", { title: "Preview a restore", description: "Show what restoring a backup would change.", inputSchema: { backupId: z.string() } }, async ({ backupId }) => {
    try {
      const p = await nomad.previewRestore(backupId);
      return text({ ...p, items: p.items.map(({ diff: _d, ...i }) => i) });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("restore_backup", { title: "Restore a backup", description: "Restore files from a backup. Only after the user approved the restore preview.", inputSchema: { backupId: z.string() } }, async ({ backupId }) => {
    try {
      if (!options.allowWrites) throw new NomadError("This Nomad MCP server is read only.", "forbidden", "Start it with --allow-writes.");
      const r = await nomad.restore(backupId);
      return text({ restored: r.preview.changes, safetyBackup: r.safetyBackup });
    } catch (e) {
      return fail(e);
    }
  });

  return { server, nomad };
}

export async function startMcpServer(options: McpOptions = {}) {
  const { server, nomad } = createMcpServer(options);
  const transport = new StdioServerTransport();
  process.on("exit", () => nomad.close());
  await server.connect(transport);
}
