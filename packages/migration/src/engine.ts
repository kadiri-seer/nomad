import { promises as fsp, constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { COMPONENT_CATEGORIES, parseDocument, type AgentDocument, type ComponentCategory, type PermissionPolicy } from "@nomad/schema";
import {
  canonicalJson,
  componentCount,
  disableWorkflows,
  documentHash,
  duplicateDocument,
  filterComponents,
  NOMAD_VERSION,
  NomadError,
  sha256,
  shortId,
  type Adapter,
  type ConflictMode,
  type Conversion,
  type Note,
  type PlannedWrite,
  type UnsupportedItem,
  type VerifyCheck,
  type WriteContext
} from "@nomad/core";
import { atomicWrite, displayPath, makeTempDir, nomadHome, resolveRoot, safeJoin } from "@nomad/core/node";
import { sanitizeDocument, scanDocument, type DocumentScan, type SanitizeReport } from "@nomad/security";
import { packAgent, packInterchange, unpackAgent, INTERCHANGE_EXTENSION, PACKAGE_EXTENSION, type UnpackResult } from "@nomad/archive";
import { analyzeCompatibility, type CompatibilityReport } from "@nomad/compatibility";
import { getAdapter, findAdapter, listAdapters, scanPlatforms } from "@nomad/adapters";
import { NomadStore } from "@nomad/storage";
import { applyOperations, computeOperations, type FileOperation } from "./ops";
import { createBackup, previewRestore, restoreBackup, type RestorePreview } from "./backup";
import { unenforcedRestrictions, widenedPermissions } from "./policy";
import { compareDocuments, type Comparison } from "./compare";

export type SourceSpec =
  | { kind: "location"; adapter: string; root: string; nativeId: string }
  | { kind: "stored"; agentId: string; version?: number }
  | { kind: "package"; path?: string; bytes?: Uint8Array };

export interface DestinationSpec {
  adapter: string;
  root: string;
  nativeId?: string;
}

export interface PlanRequest {
  source: SourceSpec;
  destination: DestinationSpec;
  mode?: ConflictMode;
  components?: ComponentCategory[];
  targetName?: string;
  includeSecrets?: boolean;
  includeFiles?: boolean;
  kind?: "migrate" | "sync" | "import";
}

export interface Approvals {
  /** Approve replacing content Nomad did not write (replace mode). */
  replace?: boolean;
  /** Approve overwriting content edited after Nomad wrote it. */
  overwriteModified?: boolean;
  /** Approve a destination policy that is broader than before. */
  broaderPermissions?: boolean;
}

export type ApprovalKind = "replace" | "overwrite-modified" | "broader-permissions";

export interface PlanOperationView {
  path: string;
  action: FileOperation["action"];
  component: ComponentCategory;
  description: string;
  strategy: string;
  conflicts: string[];
  userModified: boolean;
  replacesForeign: boolean;
  sizeBefore: number | null;
  sizeAfter: number | null;
  diff?: string;
  error?: string;
}

export interface MigrationPlan {
  id: string;
  token: string;
  createdAt: string;
  kind: "migrate" | "sync" | "import";
  agent: { id: string; name: string; version?: number };
  source: { label: string; adapter: string | null; root?: string; nativeId?: string };
  destination: { adapter: string; displayName: string; root: string; nativeId: string; support: string; guided: boolean };
  mode: ConflictMode;
  components: ComponentCategory[];
  compatibility: CompatibilityReport;
  operations: PlanOperationView[];
  conflicts: Array<{ path: string; detail: string }>;
  permissions: { widened: string[]; unenforced: string[]; before: PermissionPolicy | null; after: PermissionPolicy | null };
  conversions: Conversion[];
  unsupported: UnsupportedItem[];
  manualSteps: string[];
  notes: Note[];
  disabledRoutines: string[];
  secrets: { findings: number; redacted: number; strippedEnv: string[]; sensitiveFiles: number; included: boolean };
  summary: { create: number; update: number; unchanged: number; kept: number; transfer: number; convert: number; manual: number; unsupported: number };
  approvalsRequired: ApprovalKind[];
  blocked: string[];
}

export interface MigrationReceipt {
  operationId: string;
  kind: "migrate" | "sync" | "import";
  status: "success" | "verification-failed" | "failed-rolled-back" | "blocked";
  agent: { id: string; name: string };
  source: string;
  destination: { adapter: string; root: string; nativeId: string };
  startedAt: string;
  finishedAt: string;
  generator: string;
  packageVersion: number;
  adapterVersions: Record<string, string>;
  transferred: Array<{ category: ComponentCategory; items: number; status: string }>;
  converted: Conversion[];
  excluded: UnsupportedItem[];
  files: Array<{ path: string; action: string }>;
  warnings: string[];
  verification: VerifyCheck[];
  backupId: string | null;
  manualSteps: string[];
  disabledRoutines: string[];
  error?: string;
}

interface PreparedPlan {
  plan: MigrationPlan;
  ops: FileOperation[];
  doc: AgentDocument;
  adapter: Adapter;
  ctx: WriteContext;
  planned: PlannedWrite;
}

export interface LoadedAgent {
  doc: AgentDocument;
  notes: Note[];
  scan: DocumentScan;
  sanitize: SanitizeReport;
  version?: number;
  sourceFiles: string[];
  sourceAdapter: Adapter | null;
}

const PLAN_TTL_MS = 30 * 60 * 1000;

/**
 * The Nomad engine. CLI, web application and MCP server all call into this
 * class, so migration logic exists in exactly one place.
 */
export class Nomad {
  readonly store: NomadStore;
  private plans = new Map<string, PreparedPlan & { at: number }>();

  constructor(options: { home?: string; store?: NomadStore } = {}) {
    this.store = options.store ?? NomadStore.open(options.home ?? nomadHome());
  }

  close() {
    this.store.close();
  }

  /* ------------------------------------------------------------------ */
  /* Discovery and reading                                               */
  /* ------------------------------------------------------------------ */

  adapters() {
    return listAdapters().map((a) => a.info);
  }

  async scan(extra: Array<{ adapter: string; root: string }> = []) {
    const saved = this.store.getSetting<Array<{ adapter: string; root: string }>>("extraRoots", []);
    const found = await scanPlatforms([...saved.filter((r) => findAdapter(r.adapter)), ...extra]);
    return found.map((p) => ({
      ...p,
      agents: p.agents.map((a) => ({ ...a, agentId: this.store.findByLocation(p.adapter, p.root, a.nativeId)?.agentId ?? null }))
    }));
  }

  async discover(adapterId: string, root: string) {
    const adapter = getAdapter(adapterId);
    const r = resolveRoot(root);
    const detection = await adapter.detect(r);
    const agents = await adapter.discover(r);
    return { adapter: adapter.info, root: r, detection, agents: agents.map((a) => ({ ...a, agentId: this.store.findByLocation(adapterId, r, a.nativeId)?.agentId ?? null })) };
  }

  /**
   * Read an agent from a platform and register it. The portable identity is
   * recovered from Nomad markers or from the local identity mapping, so reading
   * the same agent twice never creates a duplicate.
   */
  async readLocation(adapterId: string, root: string, nativeId: string, options: { includeSecrets?: boolean; includeFiles?: boolean; register?: boolean } = {}): Promise<LoadedAgent> {
    const adapter = getAdapter(adapterId);
    if (!adapter.read) throw new NomadError(`${adapter.info.displayName} cannot be read by Nomad.`, "not-readable", "Guided platforms only accept agents.");
    const r = resolveRoot(root);
    const result = await adapter.read(r, nativeId, { includeFiles: options.includeFiles, includeSecrets: options.includeSecrets });
    let doc = parseDocument(result.doc);
    const mapped = this.store.findByLocation(adapterId, r, nativeId);
    // A known id means it came from a Nomad marker in the files. Otherwise the
    // local identity mapping for this location decides, so re-reading never duplicates.
    if (!this.store.getAgent(doc.id) && mapped) doc = { ...doc, id: mapped.agentId };
    const existing = this.store.getAgent(doc.id);
    if (existing) doc = { ...doc, createdAt: existing.createdAt };
    const scan = scanDocument(doc);
    const clean = sanitizeDocument(doc, { includeSecrets: false });
    let version: number | undefined;
    if (options.register !== false) {
      const saved = this.store.saveAgent(clean.doc, { reason: `Read from ${adapter.info.displayName}`, platform: adapterId });
      version = saved.version;
      this.store.upsertLocation({ agentId: doc.id, adapter: adapterId, root: r, nativeId, hash: documentHash(clean.doc), role: mapped?.role === "primary" || !this.store.locationsFor(doc.id).length ? "primary" : undefined });
    }
    const out = options.includeSecrets ? sanitizeDocument(doc, { includeSecrets: true }) : clean;
    return { doc: out.doc, notes: result.notes, scan, sanitize: clean.report, version, sourceFiles: result.sourceFiles, sourceAdapter: adapter };
  }

  async loadSource(source: SourceSpec, options: { includeSecrets?: boolean; includeFiles?: boolean } = {}): Promise<LoadedAgent & { label: string; unpack?: UnpackResult }> {
    switch (source.kind) {
      case "location": {
        const r = await this.readLocation(source.adapter, source.root, source.nativeId, options);
        return { ...r, label: `${r.sourceAdapter!.info.displayName} (${displayPath(resolveRoot(source.root))})` };
      }
      case "stored": {
        const agent = this.store.resolveAgent(source.agentId);
        if (!agent) throw new NomadError(`No agent "${source.agentId}" in the local library.`, "not-found", 'Run "nomad list" to see stored agents.');
        const doc = source.version ? this.store.versionDocument(agent.id, source.version) : this.store.latestDocument(agent.id);
        if (!doc) throw new NomadError(`Version ${source.version} of ${agent.name} does not exist.`, "not-found");
        const scan = scanDocument(doc);
        const s = sanitizeDocument(doc, {});
        const adapter = findAdapter(doc.source.platform) ?? null;
        return { doc: s.doc, notes: [], scan, sanitize: s.report, version: source.version ?? agent.currentVersion, sourceFiles: [], sourceAdapter: adapter, label: `${agent.name} v${source.version ?? agent.currentVersion} (library)` };
      }
      case "package": {
        const bytes = source.bytes ?? new Uint8Array(await fsp.readFile(source.path!));
        const u = unpackAgent(bytes, { includeSecrets: options.includeSecrets });
        if (!u.ok || !u.doc) throw new NomadError("The package is not valid: " + u.issues.map((i) => `${i.path}: ${i.message}`).join("; "), "invalid-package");
        return { doc: u.doc, notes: u.warnings.map((w) => ({ level: "warning" as const, message: w })), scan: u.scan!, sanitize: u.sanitize!, sourceFiles: [], sourceAdapter: null, label: source.path ? basename(source.path) : "uploaded package", unpack: u };
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Planning                                                             */
  /* ------------------------------------------------------------------ */

  async plan(req: PlanRequest): Promise<MigrationPlan> {
    this.gcPlans();
    const loaded = await this.loadSource(req.source, { includeSecrets: req.includeSecrets, includeFiles: req.includeFiles });
    const adapter = getAdapter(req.destination.adapter);
    if (!adapter.plan) throw new NomadError(`${adapter.info.displayName} cannot be written to.`, "not-writable");
    const root = resolveRoot(req.destination.root);
    const mode: ConflictMode = req.mode ?? "merge";
    const components = req.components?.length ? req.components : [...COMPONENT_CATEGORIES];
    const doc = disableWorkflows(filterComponents(loaded.doc, components));
    const ctx: WriteContext = { root, mode, targetName: req.targetName, targetNativeId: req.destination.nativeId, components };
    const compatibility = analyzeCompatibility(doc, loaded.sourceAdapter?.info ?? null, adapter.info);
    const planned = await adapter.plan(doc, ctx);
    const ops = await computeOperations(planned.files, { root, mode, store: this.store, agentId: doc.id });

    const blocked: string[] = [];
    for (const n of planned.notes) if (n.level === "error") blocked.push(n.message);
    for (const op of ops) if (op.error) blocked.push(`${op.display || op.rel}: ${op.error}`);
    if (req.source.kind === "location" && resolveRoot(req.source.root) === root && req.source.adapter === req.destination.adapter && (req.destination.nativeId ?? planned.nativeId) === req.source.nativeId && mode !== "copy") {
      blocked.push("Source and destination are the same agent. Choose another destination or use copy mode.");
    }

    // Permission safety: compare destination policy before and after.
    let before: PermissionPolicy | null = null;
    let after: PermissionPolicy | null = null;
    let widened: string[] = [];
    if (adapter.readPolicy && adapter.info.support !== "GUIDED") {
      before = await adapter.readPolicy(root, planned.nativeId);
      after = await this.policyAfter(adapter, root, planned.nativeId, ops);
      widened = widenedPermissions(before, after);
    }
    const unenforced = [
      ...new Set([
        ...(components.includes("permissions") && adapter.readPolicy && adapter.info.support !== "GUIDED" ? unenforcedRestrictions(doc.permissions, after) : []),
        ...planned.unsupported.filter((u) => u.category === "permissions" && !u.item.startsWith("allow ")).map((u) => u.item)
      ])
    ];

    const approvalsRequired: ApprovalKind[] = [];
    const changing = ops.filter((o) => o.action === "create" || o.action === "update");
    if (mode === "replace" && changing.some((o) => o.replacesForeign)) approvalsRequired.push("replace");
    if (changing.some((o) => o.userModified)) approvalsRequired.push("overwrite-modified");
    if (widened.length) approvalsRequired.push("broader-permissions");

    const notes = [...loaded.notes, ...planned.notes];
    if (!(await adapter.detect(root)).detected && adapter.info.support !== "GUIDED") {
      notes.push({ level: "info", message: `${adapter.info.displayName} was not detected at ${displayPath(root)}. Nomad will create the files there.` });
    }
    if (loaded.sanitize.redactedText || loaded.sanitize.strippedEnvValues.length) {
      notes.push({ level: "warning", message: `${loaded.sanitize.redactedText} secret value(s) in text were redacted and ${loaded.sanitize.strippedEnvValues.length} credential(s) were replaced by references.` });
    }

    const statusCount = (s: string) => compatibility.categories.filter((c) => c.status === s).length;
    const id = shortId("plan");
    const plan: MigrationPlan = {
      id,
      token: sha256(canonicalJson(ops.map((o) => [o.abs, o.beforeHash, o.afterHash]))).slice(0, 16),
      createdAt: new Date().toISOString(),
      kind: req.kind ?? "migrate",
      agent: { id: doc.id, name: doc.name, version: loaded.version },
      source: { label: loaded.label, adapter: loaded.sourceAdapter?.info.id ?? null, root: req.source.kind === "location" ? resolveRoot(req.source.root) : undefined, nativeId: req.source.kind === "location" ? req.source.nativeId : undefined },
      destination: { adapter: adapter.info.id, displayName: adapter.info.displayName, root, nativeId: planned.nativeId, support: adapter.info.support, guided: adapter.info.support === "GUIDED" },
      mode,
      components,
      compatibility,
      operations: ops.map((o) => ({
        path: o.display || o.rel,
        action: o.action,
        component: o.component,
        description: o.description,
        strategy: o.strategy,
        conflicts: o.conflicts,
        userModified: o.userModified,
        replacesForeign: o.replacesForeign,
        sizeBefore: o.before?.length ?? null,
        sizeAfter: o.after?.length ?? null,
        diff: o.diff,
        error: o.error
      })),
      conflicts: ops.filter((o) => o.conflicts.length && o.action !== "unchanged").flatMap((o) => o.conflicts.map((c) => ({ path: o.display, detail: c }))),
      permissions: { widened, unenforced, before, after },
      conversions: planned.conversions,
      unsupported: planned.unsupported,
      manualSteps: planned.manualSteps,
      notes,
      disabledRoutines: doc.workflows.map((w) => w.name),
      secrets: {
        findings: loaded.scan.findings.length,
        redacted: loaded.sanitize.redactedText,
        strippedEnv: loaded.sanitize.strippedEnvValues.map((s) => `${s.tool}:${s.key}`),
        sensitiveFiles: loaded.scan.sensitiveFiles.length,
        included: !!req.includeSecrets
      },
      summary: {
        create: ops.filter((o) => o.action === "create").length,
        update: ops.filter((o) => o.action === "update").length,
        unchanged: ops.filter((o) => o.action === "unchanged").length,
        kept: ops.filter((o) => o.action === "keep-existing").length,
        transfer: statusCount("full"),
        convert: statusCount("convert"),
        manual: statusCount("manual"),
        unsupported: statusCount("unsupported")
      },
      approvalsRequired,
      blocked
    };
    this.plans.set(id, { plan, ops, doc, adapter, ctx, planned, at: Date.now() });
    return plan;
  }

  private async policyAfter(adapter: Adapter, root: string, nativeId: string, ops: FileOperation[]): Promise<PermissionPolicy | null> {
    const changed = ops.filter((o) => o.after && o.root === root);
    if (!changed.length) return adapter.readPolicy!(root, nativeId);
    const tmp = await makeTempDir("nomad-overlay-");
    const overlay = join(tmp, basename(root));
    try {
      await fsp.mkdir(overlay, { recursive: true });
      for (const o of ops) {
        if (o.root !== root) continue;
        const data = o.after ?? o.before;
        if (!data) continue;
        const p = safeJoin(overlay, o.rel);
        await fsp.mkdir(dirname(p), { recursive: true });
        await fsp.writeFile(p, data);
      }
      // Policy files that the plan does not touch still count.
      for (const f of ["settings.json", ".claude/settings.json", "config.toml", ".codex/config.toml", "openclaw.json", "config.yaml"]) {
        const src = join(root, f);
        const dst = join(overlay, f);
        try {
          await fsp.access(dst);
        } catch {
          try {
            const data = await fsp.readFile(src);
            await fsp.mkdir(dirname(dst), { recursive: true });
            await fsp.writeFile(dst, data);
          } catch {
            /* absent */
          }
        }
      }
      return await adapter.readPolicy!(overlay, nativeId);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  getPlan(id: string): MigrationPlan | undefined {
    return this.plans.get(id)?.plan;
  }

  private gcPlans() {
    const now = Date.now();
    for (const [k, v] of this.plans) if (now - v.at > PLAN_TTL_MS) this.plans.delete(k);
  }

  /* ------------------------------------------------------------------ */
  /* Execution                                                            */
  /* ------------------------------------------------------------------ */

  async execute(planId: string, approvals: Approvals = {}, options: { token?: string } = {}): Promise<MigrationReceipt> {
    const prepared = this.plans.get(planId);
    if (!prepared) throw new NomadError("This preview has expired or does not exist. Create a new preview.", "plan-missing");
    const { plan, ops, doc, adapter, ctx, planned } = prepared;
    if (options.token && options.token !== plan.token) throw new NomadError("The approval does not match this preview.", "token-mismatch");
    if (plan.blocked.length) throw new NomadError("This migration cannot run: " + plan.blocked.join(" "), "blocked");
    const missing = plan.approvalsRequired.filter(
      (a) => (a === "replace" && !approvals.replace) || (a === "overwrite-modified" && !approvals.overwriteModified) || (a === "broader-permissions" && !approvals.broaderPermissions)
    );
    if (missing.length) {
      throw new NomadError(`Explicit approval is required: ${missing.join(", ")}.`, "approval-required", "Review the preview and approve these changes to continue.");
    }

    const operationId = shortId("op");
    const startedAt = new Date().toISOString();
    const release = await this.lock();
    const changing = ops.filter((o) => o.action === "create" || o.action === "update");
    let backupId: string | null = null;
    const base: Omit<MigrationReceipt, "status" | "finishedAt" | "verification" | "files"> = {
      operationId,
      kind: plan.kind,
      agent: { id: doc.id, name: doc.name },
      source: plan.source.label,
      destination: { adapter: adapter.info.id, root: ctx.root, nativeId: planned.nativeId },
      startedAt,
      generator: `nomad ${NOMAD_VERSION}`,
      packageVersion: doc.packageVersion,
      adapterVersions: { [adapter.info.id]: adapter.info.adapterVersion, ...(plan.source.adapter ? { [plan.source.adapter]: findAdapter(plan.source.adapter)?.info.adapterVersion ?? "" } : {}) },
      transferred: plan.compatibility.categories.filter((c) => c.items > 0 && c.status !== "unsupported").map((c) => ({ category: c.category, items: c.items, status: c.statusLabel })),
      converted: planned.conversions,
      excluded: planned.unsupported,
      warnings: [...plan.notes.filter((n) => n.level !== "info").map((n) => n.message), ...plan.conflicts.map((c) => `${c.path}: ${c.detail}`), ...plan.permissions.unenforced.map((u) => `Not enforced at the destination: ${u}`)],
      backupId: null,
      manualSteps: planned.manualSteps,
      disabledRoutines: plan.disabledRoutines
    };
    try {
      if (changing.length) {
        const backup = await createBackup(this.store, changing.map((o) => ({ root: o.root, abs: o.abs })), { kind: plan.kind === "sync" ? "pre-sync" : "pre-migration", operationId, agentId: doc.id, description: `Before ${plan.kind} of ${doc.name} to ${adapter.info.displayName}` });
        backupId = backup.id;
      }
      try {
        await applyOperations(ops);
      } catch (e) {
        const receipt: MigrationReceipt = { ...base, backupId, status: "failed-rolled-back", finishedAt: new Date().toISOString(), verification: [], files: [], error: (e as Error).message };
        this.store.saveOperation({ id: operationId, kind: plan.kind, agentId: doc.id, source: plan.source.label, destination: `${adapter.info.id}:${ctx.root}`, status: receipt.status, createdAt: startedAt, receipt });
        return receipt;
      }
      for (const o of changing) this.store.recordWrite(o.recordKey, o.recordHash!, doc.id, operationId);

      const verification: VerifyCheck[] = [];
      for (const o of changing) {
        try {
          const data = new Uint8Array(await fsp.readFile(o.abs));
          if (sha256(data) !== o.afterHash) verification.push({ name: `${o.display} written`, ok: false, detail: "Content differs from what was planned" });
        } catch {
          verification.push({ name: `${o.display} written`, ok: false, detail: "File is missing" });
        }
      }
      if (!verification.length) verification.push({ name: `${changing.length} file(s) written as planned`, ok: true });
      if (adapter.verify && adapter.info.support !== "GUIDED") {
        try {
          verification.push(...(await adapter.verify(doc, ctx.root, planned.nativeId, ctx)));
        } catch (e) {
          verification.push({ name: "Destination verification", ok: false, detail: (e as Error).message });
        }
      }
      const ok = verification.every((v) => v.ok);
      if (adapter.info.support !== "GUIDED") {
        this.store.upsertLocation({ agentId: doc.id, adapter: adapter.info.id, root: ctx.root, nativeId: planned.nativeId, hash: documentHash(doc) });
      }
      const stored = this.store.latestDocument(doc.id);
      const base2 = stored ?? doc;
      const withHistory: AgentDocument = { ...base2, history: [...base2.history, { operationId, kind: plan.kind === "import" ? "import" : plan.kind, from: plan.source.label, to: `${adapter.info.displayName} (${displayPath(ctx.root)})`, at: startedAt }] };
      this.store.saveAgent(withHistory, { reason: `${plan.kind === "sync" ? "Synced" : "Migrated"} to ${adapter.info.displayName}`, operationId, platform: adapter.info.id });
      const receipt: MigrationReceipt = {
        ...base,
        backupId,
        status: ok ? "success" : "verification-failed",
        finishedAt: new Date().toISOString(),
        verification,
        files: ops.map((o) => ({ path: o.display, action: o.action }))
      };
      this.store.saveOperation({ id: operationId, kind: plan.kind, agentId: doc.id, source: plan.source.label, destination: `${adapter.info.id}:${ctx.root}`, status: receipt.status, createdAt: startedAt, receipt });
      this.plans.delete(planId);
      return receipt;
    } finally {
      await release();
    }
  }

  private async lock(): Promise<() => Promise<void>> {
    const path = join(this.store.home, "migration.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await fsp.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        await fh.writeFile(String(process.pid));
        await fh.close();
        return async () => {
          await fsp.rm(path, { force: true });
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const pid = Number(await fsp.readFile(path, "utf8").catch(() => "0"));
        let alive = false;
        try {
          if (pid) {
            process.kill(pid, 0);
            alive = pid !== process.pid || false;
          }
        } catch {
          alive = false;
        }
        if (alive) throw new NomadError("Another Nomad operation is running.", "locked", "Wait for it to finish and try again.");
        await fsp.rm(path, { force: true });
      }
    }
    throw new NomadError("Could not acquire the operation lock.", "locked");
  }

  /* ------------------------------------------------------------------ */
  /* Export and import                                                    */
  /* ------------------------------------------------------------------ */

  async exportAgent(source: SourceSpec, options: { outPath?: string; includeSecrets?: boolean; includeSensitiveFiles?: boolean; includeFiles?: boolean; components?: ComponentCategory[]; format?: "agentpack" | "interchange" } = {}) {
    const loaded = await this.loadSource(source, { includeSecrets: options.includeSecrets, includeFiles: options.includeFiles });
    const doc = options.components?.length ? filterComponents(loaded.doc, options.components) : loaded.doc;
    const operationId = shortId("op");
    const withHistory: AgentDocument = { ...doc, history: [...doc.history, { operationId, kind: "export", from: loaded.label, at: new Date().toISOString() }] };
    const packOpts = { includeSecrets: options.includeSecrets, includeSensitiveFiles: options.includeSensitiveFiles, includeFiles: options.includeFiles };
    const interchange = options.format === "interchange" || options.outPath?.endsWith(INTERCHANGE_EXTENSION);
    const pack = interchange ? { ...packInterchange(withHistory, packOpts), manifest: null } : { ...packAgent(withHistory, packOpts), carried: [] as string[], dropped: [] as string[] };
    const ext = interchange ? INTERCHANGE_EXTENSION : PACKAGE_EXTENSION;
    let path: string | null = null;
    if (options.outPath !== undefined) {
      path = options.outPath.endsWith(ext) ? options.outPath : join(options.outPath, `${doc.name.replace(/[^A-Za-z0-9._-]+/g, "-")}${ext}`);
      await atomicWrite(path, pack.bytes, 0o600);
    }
    const receipt = {
      operationId,
      kind: "export",
      status: "success",
      agent: { id: doc.id, name: doc.name },
      source: loaded.label,
      path,
      size: pack.bytes.length,
      secretsIncluded: !!options.includeSecrets,
      redacted: pack.sanitize.redactedText,
      strippedEnv: pack.sanitize.strippedEnvValues.length,
      removedFiles: pack.sanitize.removedFiles,
      findings: pack.scan.findings.map((f) => ({ ruleName: f.ruleName, file: f.file, line: f.line })),
      format: interchange ? "interchange" : "agentpack",
      carriedInExtension: pack.carried,
      notIncluded: pack.dropped,
      at: new Date().toISOString()
    };
    this.store.saveOperation({ id: operationId, kind: "export", agentId: doc.id, source: loaded.label, destination: path, status: "success", createdAt: receipt.at, receipt });
    return { ...pack, path, receipt };
  }

  /** Validate a package without importing it. */
  validatePackage(bytes: Uint8Array): UnpackResult {
    return unpackAgent(bytes);
  }

  /** Import a package into the local library. Use plan() with a package source to also write it to a platform. */
  async importPackage(input: { path?: string; bytes?: Uint8Array }) {
    const bytes = input.bytes ?? new Uint8Array(await fsp.readFile(input.path!));
    const u = unpackAgent(bytes);
    if (!u.ok || !u.doc) return { ok: false as const, issues: u.issues, warnings: u.warnings };
    const known = this.store.getAgent(u.doc.id);
    const operationId = shortId("op");
    const doc: AgentDocument = { ...u.doc, history: [...u.doc.history, { operationId, kind: "import", from: input.path ? basename(input.path) : "package", at: new Date().toISOString() }] };
    const saved = this.store.saveAgent(doc, { reason: "Imported package", operationId, platform: doc.source.platform });
    const receipt = { operationId, kind: "import", status: "success", agent: { id: doc.id, name: doc.name }, recognized: !!known, version: saved.version, warnings: u.warnings, findings: u.scan?.findings.length ?? 0, redacted: u.sanitize?.redactedText ?? 0, executableFiles: u.executableFiles, at: new Date().toISOString() };
    this.store.saveOperation({ id: operationId, kind: "import", agentId: doc.id, source: input.path ?? "package", destination: "library", status: "success", createdAt: receipt.at, receipt });
    return { ok: true as const, agentId: doc.id, name: doc.name, version: saved.version, recognized: !!known, warnings: u.warnings, scan: u.scan, sanitize: u.sanitize, executableFiles: u.executableFiles, receipt };
  }

  /* ------------------------------------------------------------------ */
  /* Library, versions, comparison                                        */
  /* ------------------------------------------------------------------ */

  listAgents() {
    return this.store.listAgents().map((a) => {
      const doc = a.currentHash ? this.store.getObject(a.currentHash) : null;
      return {
        ...a,
        locations: this.store.locationsFor(a.id),
        counts: doc ? Object.fromEntries(COMPONENT_CATEGORIES.map((c) => [c, componentCount(doc, c)])) : {},
        memoryEntries: doc?.memory.length ?? 0,
        skills: doc?.skills.length ?? 0
      };
    });
  }

  agentDetail(ref: string) {
    const a = this.store.resolveAgent(ref);
    if (!a) throw new NomadError(`No agent "${ref}" in the local library.`, "not-found");
    const doc = this.store.latestDocument(a.id)!;
    return { agent: a, doc, versions: this.store.listVersions(a.id), locations: this.store.locationsFor(a.id), operations: this.store.listOperations(a.id), backups: this.store.listBackups(a.id) };
  }

  compareVersions(ref: string, left: number, right: number): Comparison {
    const a = this.store.resolveAgent(ref);
    if (!a) throw new NomadError(`No agent "${ref}".`, "not-found");
    const l = this.store.versionDocument(a.id, left);
    const r = this.store.versionDocument(a.id, right);
    if (!l || !r) throw new NomadError("Version not found.", "not-found");
    return compareDocuments(l, r, { left: `v${left}`, right: `v${right}` });
  }

  /** Compare the agent as it currently exists at two locations. */
  async compareLocations(a: { adapter: string; root: string; nativeId: string }, b: { adapter: string; root: string; nativeId: string }): Promise<Comparison> {
    const la = await this.readLocation(a.adapter, a.root, a.nativeId, { register: false });
    const lb = await this.readLocation(b.adapter, b.root, b.nativeId, { register: false });
    return compareDocuments(la.doc, lb.doc, { left: `${a.adapter}:${displayPath(resolveRoot(a.root))}`, right: `${b.adapter}:${displayPath(resolveRoot(b.root))}` });
  }

  /** Restore an earlier version as the current library version (files are not touched). */
  restoreVersion(ref: string, version: number) {
    const a = this.store.resolveAgent(ref);
    if (!a) throw new NomadError(`No agent "${ref}".`, "not-found");
    const doc = this.store.versionDocument(a.id, version);
    if (!doc) throw new NomadError("Version not found.", "not-found");
    const current = this.store.latestDocument(a.id)!;
    const comparison = compareDocuments(current, doc, { left: "current", right: `v${version}` });
    const saved = this.store.saveAgent({ ...doc, history: current.history }, { reason: `Restored version ${version}`, platform: doc.source.platform });
    return { comparison, version: saved.version };
  }

  duplicateAgent(ref: string, name?: string) {
    const a = this.store.resolveAgent(ref);
    if (!a) throw new NomadError(`No agent "${ref}".`, "not-found");
    const copy = duplicateDocument(this.store.latestDocument(a.id)!, name);
    const saved = this.store.saveAgent(copy, { reason: `Duplicated from ${a.name}` });
    return { agentId: copy.id, name: copy.name, version: saved.version };
  }

  history(ref?: string) {
    const id = ref ? this.store.resolveAgent(ref)?.id : undefined;
    return this.store.listOperations(id);
  }

  /* ------------------------------------------------------------------ */
  /* Backups                                                              */
  /* ------------------------------------------------------------------ */

  /** Snapshot the native files of an agent at all its known locations. */
  async backupAgent(ref: string) {
    const a = this.store.resolveAgent(ref);
    if (!a) throw new NomadError(`No agent "${ref}".`, "not-found");
    const files: Array<{ root: string; abs: string }> = [];
    for (const loc of this.store.locationsFor(a.id)) {
      const adapter = findAdapter(loc.adapter);
      if (!adapter?.read) continue;
      try {
        const r = await adapter.read(loc.root, loc.nativeId);
        for (const f of r.sourceFiles) files.push({ root: dirname(f), abs: f });
      } catch {
        /* location no longer readable */
      }
    }
    return createBackup(this.store, files, { kind: "agent-snapshot", agentId: a.id, description: `Snapshot of ${a.name}` });
  }

  backups(ref?: string) {
    const id = ref ? this.store.resolveAgent(ref)?.id : undefined;
    return this.store.listBackups(id);
  }

  previewRestore(backupId: string): Promise<RestorePreview> {
    return previewRestore(this.store, backupId);
  }

  async restore(backupId: string) {
    const r = await restoreBackup(this.store, backupId);
    const operationId = shortId("op");
    this.store.saveOperation({ id: operationId, kind: "restore", agentId: this.store.getBackup(backupId)?.agentId ?? null, source: backupId, destination: null, status: "success", createdAt: new Date().toISOString(), receipt: { operationId, kind: "restore", backupId, changes: r.preview.changes, safetyBackup: r.safetyBackup, items: r.preview.items.map((i) => ({ path: i.path, action: i.action })) } });
    return { ...r, operationId };
  }

  /* ------------------------------------------------------------------ */
  /* Synchronization (one way, explicit)                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Plan a one-way sync from the agent's primary location to every other known
   * location. Each target gets its own preview in merge mode. Nothing is applied
   * until each plan is executed.
   */
  async planSync(ref: string, options: { from?: { adapter: string; root: string; nativeId: string } } = {}) {
    const a = this.store.resolveAgent(ref);
    if (!a) throw new NomadError(`No agent "${ref}".`, "not-found");
    const locs = this.store.locationsFor(a.id);
    const primary = options.from ? locs.find((l) => l.adapter === options.from!.adapter && l.root === resolveRoot(options.from!.root) && l.nativeId === options.from!.nativeId) : locs.find((l) => l.role === "primary") ?? locs[0];
    if (!primary) throw new NomadError(`${a.name} has no known locations.`, "no-locations");
    const plans: MigrationPlan[] = [];
    for (const loc of locs) {
      if (loc.id === primary.id) continue;
      const adapter = findAdapter(loc.adapter);
      if (!adapter?.plan || adapter.info.support === "GUIDED") continue;
      plans.push(
        await this.plan({
          kind: "sync",
          source: { kind: "location", adapter: primary.adapter, root: primary.root, nativeId: primary.nativeId },
          destination: { adapter: loc.adapter, root: loc.root, nativeId: loc.nativeId },
          mode: "merge"
        })
      );
    }
    return { primary, plans };
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                             */
  /* ------------------------------------------------------------------ */

  settings() {
    return { home: this.store.home, ...this.store.allSettings() };
  }

  setSetting(key: string, value: unknown) {
    if (!/^[a-zA-Z][\w.-]*$/.test(key)) throw new NomadError("Invalid setting name.", "invalid-setting");
    this.store.setSetting(key, value);
  }
}
