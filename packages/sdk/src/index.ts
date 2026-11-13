/**
 * Nomad adapter SDK.
 *
 * Everything needed to build an adapter for a new platform without touching
 * the migration engine: the contract, capability helpers, shared Markdown,
 * memory, skill and MCP helpers, and a contract test harness.
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPONENT_CATEGORIES, validateDocument, type AgentDocument } from "@nomad/schema";
import { createDocument, sha256, type Adapter, type CategorySupport } from "@nomad/core";
import { registerAdapter } from "@nomad/adapters";
import { Nomad } from "@nomad/migration";

export type {
  Adapter,
  AdapterInfo,
  AgentRef,
  CapabilityMatrix,
  CategoryCapability,
  CategorySupport,
  ConflictMode,
  Conversion,
  DesiredFile,
  DetectResult,
  GuidedKit,
  Note,
  PlannedWrite,
  ReadOptions,
  ReadResult,
  SupportLevel,
  UnsupportedItem,
  VerifyCheck,
  WriteContext,
  WriteStrategy
} from "@nomad/core";
export { capabilityMatrix, createDocument, parseFrontmatter, stringifyFrontmatter, wrapBlock, extractBlock, findAgentIdMarker, firstHeading, slugify } from "@nomad/core";
export type { AgentDocument, MemoryEntry, Skill, Tool, Workflow, PermissionPolicy, PermissionRule, ComponentCategory } from "@nomad/schema";
export {
  readSkillDir,
  readSkillsTree,
  skillToFiles,
  parseMemoryMarkdown,
  renderMemoryMarkdown,
  parseMixedMemory,
  renderAgentMarkdown,
  parseAgentMarkdown,
  toolsFromMcpServers,
  mcpServersFromTools,
  modelFamily,
  nomadBlockKey,
  workflowManualSteps,
  defineFileAdapter,
  registerAdapter,
  type FileAdapterSpec
} from "@nomad/adapters";

export interface ContractFixture {
  /** Build a platform layout under `home` and return its root. */
  build: (home: string) => string;
  nativeId: string;
  /** Minimum counts the read must produce. */
  expect?: Partial<Record<"instructions" | "memory" | "skills" | "tools" | "workflows", number>>;
  /**
   * Secret values planted in the fixture (keys, key file contents). None may
   * appear in a plan, a receipt or any file written at the destination when the
   * fixture agent is migrated.
   */
  secrets?: string[];
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

/** Planted values found in any text, plus anything shaped like an "sk-" API key. Reported by length only. */
function leakedSecrets(texts: string[], secrets: string[]): string[] {
  const found = secrets.filter((s) => s && texts.some((t) => t.includes(s))).map((s) => `${s.length} character secret`);
  if (texts.some((t) => /\bsk-[A-Za-z0-9_-]{20,}/.test(t))) found.push("an sk- API key");
  return found;
}

export interface ContractResult {
  name: string;
  ok: boolean;
  detail?: string;
}

function tree(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, `${rel}${n}/`);
      else parts.push(rel + n + ":" + sha256(new Uint8Array(readFileSync(p))));
    }
  };
  walk(dir, "");
  return sha256(parts.join("\n"));
}

/** A document that exercises every component category. */
export function sampleAgent(): AgentDocument {
  const d = createDocument({ name: "Contract Sample", platform: "sdk", description: "Adapter contract sample" });
  d.identity.persona = "You are a careful sample agent.";
  d.instructions.push({ id: "main", kind: "agent", content: "Follow the contract." });
  d.memory.push({ id: "m-1", kind: "fact", scope: "agent", content: "The sky is blue.", tags: [] }, { id: "m-2", kind: "profile", scope: "user", content: "User prefers short answers.", tags: [] });
  d.skills.push({ name: "sample-skill", description: "A sample skill", instructions: "Do the sample thing.", dependencies: [], platforms: [], allowedTools: [], config: {}, references: [], files: [], frontmatter: {}, invocation: "auto" });
  d.tools.push({ name: "sample-mcp", kind: "mcp", mcp: { transport: "stdio", command: "npx", args: ["-y", "sample"], env: { API_TOKEN: { secretRef: "API_TOKEN", redacted: true } }, headers: {} }, permissions: [], platforms: [], enabled: true });
  d.workflows.push({ id: "daily", name: "Daily check", trigger: { kind: "cron", expr: "0 8 * * *" }, actions: [{ kind: "prompt", text: "Check things." }], requiredTools: [], dependencies: [], conditions: [], sourceEnabled: true, enabled: false });
  d.permissions = { mode: "ask", rules: [{ capability: "shell", effect: "ask" }, { capability: "network", effect: "deny" }], notes: [] };
  return d;
}

/**
 * Run the adapter contract: capability declaration, detection, discovery,
 * read without side effects, write through the real engine, verification, and
 * idempotent re-writes. Use it from your test runner:
 *
 *   const results = await runAdapterContract(myAdapter, fixture);
 *   expect(results.filter(r => !r.ok)).toEqual([]);
 */
export async function runAdapterContract(adapter: Adapter, fixture?: ContractFixture): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail });
  const levels: CategorySupport[] = ["full", "convert", "manual", "unsupported"];
  check("id is a lowercase slug", /^[a-z0-9][a-z0-9-]*$/.test(adapter.info.id));
  check("declares every category", COMPONENT_CATEGORIES.every((c) => adapter.info.capabilities[c] && levels.includes(adapter.info.capabilities[c].read) && levels.includes(adapter.info.capabilities[c].write)));
  check("guided adapters do not claim full support", adapter.info.support !== "GUIDED" || COMPONENT_CATEGORIES.every((c) => adapter.info.capabilities[c].write !== "full"));

  const home = mkdtempSync(join(tmpdir(), "nomad-contract-"));
  const prevHome = process.env.NOMAD_FAKE_HOME;
  process.env.NOMAD_FAKE_HOME = home;
  const nomad = new Nomad({ home: join(home, ".nomad") });
  try {
    if (fixture && adapter.read) {
      registerAdapter(adapter);
      const root = fixture.build(home);
      const before = tree(root);
      const det = await adapter.detect(root);
      check("detects its fixture", det.detected, det.evidence.join(", "));
      const refs = await adapter.discover(root);
      check("discovers the fixture agent", refs.some((r) => r.nativeId === fixture.nativeId));
      const read = await adapter.read(root, fixture.nativeId);
      check("read returns a valid document", validateDocument(read.doc).ok);
      for (const [k, n] of Object.entries(fixture.expect ?? {})) check(`reads at least ${n} ${k}`, ((read.doc as any)[k]?.length ?? 0) >= n!);
      check("reading does not modify the source", tree(root) === before);
      if (fixture.secrets?.length && adapter.plan) {
        // Move the fixture agent itself and look for planted secrets everywhere it could land.
        const dest = join(home, "destination-fixture");
        const { mkdirSync } = await import("node:fs");
        mkdirSync(dest, { recursive: true });
        const plan = await nomad.plan({ source: { kind: "location", adapter: adapter.info.id, root, nativeId: fixture.nativeId }, destination: { adapter: adapter.info.id, root: dest } });
        check("the fixture agent can be written", plan.blocked.length === 0, plan.blocked.join("; "));
        const receipt = plan.blocked.length ? null : await nomad.execute(plan.id, { broaderPermissions: true, replace: true, overwriteModified: true });
        check("the fixture agent was written", !receipt || receipt.status === "success", receipt?.verification.filter((v) => !v.ok).map((v) => `${v.name}: ${v.detail ?? ""}`).join("; ") || receipt?.error);
        const leaks = [...leakedSecrets([JSON.stringify(plan), JSON.stringify(receipt), ...filesUnder(dest)], fixture.secrets), ...leakedSecrets([JSON.stringify(read)], fixture.secrets).filter((l) => !l.startsWith("an sk-")).map((l) => `${l} in the read`)];
        check("never writes secret values", leaks.length === 0, leaks.join(", "));
        check("reading does not modify the source", tree(root) === before);
      }
    }
    if (adapter.plan) {
      registerAdapter(adapter);
      const dest = join(home, "destination");
      const pkg = join(home, "sample");
      const { packAgent } = await import("@nomad/archive");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(pkg + ".agentpack", packAgent(sampleAgent()).bytes);
      const plan = await nomad.plan({ source: { kind: "package", path: pkg + ".agentpack" }, destination: { adapter: adapter.info.id, root: dest } });
      check("plans without being blocked", plan.blocked.length === 0, plan.blocked.join("; "));
      check("reports or writes every category the sample uses", plan.compatibility.categories.every((c) => c.status === "not-applicable" || c.status === "unsupported" ? plan.unsupported.some((u) => u.category === c.category) || c.status === "not-applicable" || adapter.info.support === "GUIDED" : true));
      check("imports routines disabled", plan.disabledRoutines.includes("Daily check") || plan.unsupported.some((u) => u.category === "workflows"));
      const receipt = await nomad.execute(plan.id, { broaderPermissions: true });
      check("migration succeeds and verifies", receipt.status === "success", receipt.verification.filter((v) => !v.ok).map((v) => `${v.name}: ${v.detail ?? ""}`).join("; ") || receipt.error);
      const leaks = leakedSecrets([JSON.stringify(receipt), ...filesUnder(dest)], fixture?.secrets ?? []);
      check("never writes secret values", leaks.length === 0, leaks.join(", "));
      const again = await nomad.plan({ source: { kind: "package", path: pkg + ".agentpack" }, destination: { adapter: adapter.info.id, root: dest } });
      check("re-writing the same agent changes nothing", again.summary.create === 0 && again.summary.update === 0 && again.approvalsRequired.length === 0, `${again.summary.create} new, ${again.summary.update} modified`);
    }
  } catch (e) {
    check("contract run completed", false, (e as Error).message);
  } finally {
    nomad.close();
    if (prevHome === undefined) delete process.env.NOMAD_FAKE_HOME;
    else process.env.NOMAD_FAKE_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
  return results;
}
