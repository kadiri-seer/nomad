import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { AgentDocument, parseDocument } from "@nomad/schema";
import { documentHash } from "@nomad/core";
import { nomadHome } from "@nomad/core/node";
import * as s from "./schema";

export * as tables from "./schema";

export type AgentRow = typeof s.agents.$inferSelect;
export type VersionRow = typeof s.versions.$inferSelect;
export type LocationRow = typeof s.locations.$inferSelect;
export type OperationRow = typeof s.operations.$inferSelect;
export type BackupRow = typeof s.backups.$inferSelect;

const SCHEMA_VERSION = 1;

/**
 * Local-first store. SQLite holds the index (agents, versions, locations,
 * operations, backups); agent documents are content-addressed JSON objects.
 * Everything lives under ~/.nomad (or $NOMAD_HOME) with owner-only permissions.
 */
export class NomadStore {
  readonly db: BetterSQLite3Database<typeof s>;
  private constructor(
    private readonly sqlite: Database.Database,
    readonly home: string
  ) {
    this.db = drizzle(sqlite, { schema: s });
  }

  static open(home: string = nomadHome()): NomadStore {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    for (const d of ["objects", "backups", "exports"]) mkdirSync(join(home, d), { recursive: true, mode: 0o700 });
    const dbPath = join(home, "nomad.db");
    const sqlite = new Database(dbPath);
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      /* best effort */
    }
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(s.DDL);
    const current = sqlite.pragma("user_version", { simple: true }) as number;
    if (current < SCHEMA_VERSION) sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
    return new NomadStore(sqlite, home);
  }

  close() {
    this.sqlite.close();
  }

  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  /* ----------------------------- objects ----------------------------- */

  private objectPath(hash: string) {
    return join(this.home, "objects", hash.slice(0, 2), `${hash}.json`);
  }

  putObject(doc: AgentDocument): string {
    const hash = documentHash(doc);
    const p = this.objectPath(hash);
    if (!existsSync(p)) {
      mkdirSync(join(this.home, "objects", hash.slice(0, 2)), { recursive: true, mode: 0o700 });
      writeFileSync(p, JSON.stringify(doc), { mode: 0o600 });
    }
    return hash;
  }

  getObject(hash: string): AgentDocument {
    return parseDocument(JSON.parse(readFileSync(this.objectPath(hash), "utf8")));
  }

  /* ----------------------------- agents ----------------------------- */

  listAgents(): AgentRow[] {
    return this.db.select().from(s.agents).orderBy(desc(s.agents.updatedAt)).all();
  }

  getAgent(id: string): AgentRow | undefined {
    return this.db.select().from(s.agents).where(eq(s.agents.id, id)).get();
  }

  /** Resolve an agent by id, unique id prefix or exact name. */
  resolveAgent(ref: string): AgentRow | undefined {
    const exact = this.getAgent(ref.toUpperCase());
    if (exact) return exact;
    const all = this.listAgents();
    const byPrefix = all.filter((a) => a.id.startsWith(ref.toUpperCase()));
    if (byPrefix.length === 1) return byPrefix[0];
    const byName = all.filter((a) => a.name.toLowerCase() === ref.toLowerCase());
    return byName.length === 1 ? byName[0] : undefined;
  }

  /**
   * Record a document. A new version is created only when content changed.
   * Returns the version number holding this content.
   */
  saveAgent(doc: AgentDocument, meta: { reason: string; operationId?: string; platform?: string }): { version: number; hash: string; created: boolean } {
    const hash = this.putObject(doc);
    return this.transaction(() => {
      const now = new Date().toISOString();
      const existing = this.getAgent(doc.id);
      const dup = (doc.extensions["x-nomad"] as any)?.duplicatedFrom;
      if (!existing) {
        this.db.insert(s.agents).values({ id: doc.id, name: doc.name, description: doc.description ?? null, sourcePlatform: doc.source.platform, createdAt: doc.createdAt, updatedAt: now, currentVersion: 0, currentHash: null, duplicatedFrom: dup ?? null }).run();
      }
      const latest = this.db.select().from(s.versions).where(eq(s.versions.agentId, doc.id)).orderBy(desc(s.versions.version)).limit(1).get();
      if (latest && latest.hash === hash) {
        this.db.update(s.agents).set({ name: doc.name, description: doc.description ?? null }).where(eq(s.agents.id, doc.id)).run();
        return { version: latest.version, hash, created: false };
      }
      const version = (latest?.version ?? 0) + 1;
      this.db.insert(s.versions).values({ agentId: doc.id, version, hash, createdAt: now, reason: meta.reason, operationId: meta.operationId ?? null, platform: meta.platform ?? doc.source.platform }).run();
      this.db.update(s.agents).set({ name: doc.name, description: doc.description ?? null, updatedAt: now, currentVersion: version, currentHash: hash }).where(eq(s.agents.id, doc.id)).run();
      return { version, hash, created: true };
    });
  }

  latestDocument(agentId: string): AgentDocument | undefined {
    const a = this.getAgent(agentId);
    if (!a?.currentHash) return undefined;
    return this.getObject(a.currentHash);
  }

  listVersions(agentId: string): VersionRow[] {
    return this.db.select().from(s.versions).where(eq(s.versions.agentId, agentId)).orderBy(desc(s.versions.version)).all();
  }

  versionDocument(agentId: string, version: number): AgentDocument | undefined {
    const v = this.db.select().from(s.versions).where(and(eq(s.versions.agentId, agentId), eq(s.versions.version, version))).get();
    return v ? this.getObject(v.hash) : undefined;
  }

  deleteAgent(agentId: string) {
    this.transaction(() => {
      this.db.delete(s.versions).where(eq(s.versions.agentId, agentId)).run();
      this.db.delete(s.locations).where(eq(s.locations.agentId, agentId)).run();
      this.db.delete(s.agents).where(eq(s.agents.id, agentId)).run();
    });
  }

  /* ----------------------------- locations ----------------------------- */

  findByLocation(adapter: string, root: string, nativeId: string): LocationRow | undefined {
    return this.db.select().from(s.locations).where(and(eq(s.locations.adapter, adapter), eq(s.locations.root, root), eq(s.locations.nativeId, nativeId))).get();
  }

  upsertLocation(loc: { agentId: string; adapter: string; root: string; nativeId: string; hash?: string; role?: "primary" | "copy" }) {
    const now = new Date().toISOString();
    const existing = this.findByLocation(loc.adapter, loc.root, loc.nativeId);
    if (existing) {
      this.db.update(s.locations).set({ agentId: loc.agentId, lastHash: loc.hash ?? existing.lastHash, lastSeenAt: now, role: loc.role ?? existing.role }).where(eq(s.locations.id, existing.id)).run();
    } else {
      this.db.insert(s.locations).values({ agentId: loc.agentId, adapter: loc.adapter, root: loc.root, nativeId: loc.nativeId, lastHash: loc.hash ?? null, lastSeenAt: now, role: loc.role ?? "copy" }).run();
    }
  }

  locationsFor(agentId: string): LocationRow[] {
    return this.db.select().from(s.locations).where(eq(s.locations.agentId, agentId)).all();
  }

  /* ----------------------------- written files ----------------------------- */

  recordWrite(path: string, sha256: string, agentId: string | null, operationId: string | null) {
    const now = new Date().toISOString();
    this.db.insert(s.writtenFiles).values({ path, sha256, agentId, operationId, writtenAt: now }).onConflictDoUpdate({ target: s.writtenFiles.path, set: { sha256, agentId, operationId, writtenAt: now } }).run();
  }

  forgetWrite(path: string) {
    this.db.delete(s.writtenFiles).where(eq(s.writtenFiles.path, path)).run();
  }

  lastWrite(path: string) {
    return this.db.select().from(s.writtenFiles).where(eq(s.writtenFiles.path, path)).get();
  }

  /* ----------------------------- operations ----------------------------- */

  saveOperation(op: { id: string; kind: string; agentId?: string | null; source?: string | null; destination?: string | null; status: string; createdAt: string; receipt: unknown }) {
    const row = { id: op.id, kind: op.kind, agentId: op.agentId ?? null, source: op.source ?? null, destination: op.destination ?? null, status: op.status, createdAt: op.createdAt, receipt: JSON.stringify(op.receipt) };
    this.db.insert(s.operations).values(row).onConflictDoUpdate({ target: s.operations.id, set: { status: row.status, receipt: row.receipt } }).run();
  }

  listOperations(agentId?: string): Array<OperationRow & { receiptJson: any }> {
    const q = this.db.select().from(s.operations);
    const rows = (agentId ? q.where(eq(s.operations.agentId, agentId)) : q).orderBy(desc(s.operations.createdAt)).all();
    return rows.map((r) => ({ ...r, receiptJson: JSON.parse(r.receipt) }));
  }

  getOperation(id: string) {
    const r = this.db.select().from(s.operations).where(eq(s.operations.id, id)).get();
    return r ? { ...r, receiptJson: JSON.parse(r.receipt) } : undefined;
  }

  /* ----------------------------- backups ----------------------------- */

  addBackup(b: { id: string; operationId?: string | null; agentId?: string | null; kind: string; path: string; fileCount: number; description?: string }) {
    this.db.insert(s.backups).values({ id: b.id, operationId: b.operationId ?? null, agentId: b.agentId ?? null, kind: b.kind, createdAt: new Date().toISOString(), path: b.path, fileCount: b.fileCount, description: b.description ?? null }).run();
  }

  listBackups(agentId?: string): BackupRow[] {
    const q = this.db.select().from(s.backups);
    return (agentId ? q.where(eq(s.backups.agentId, agentId)) : q).orderBy(desc(s.backups.createdAt)).all();
  }

  getBackup(id: string): BackupRow | undefined {
    return this.db.select().from(s.backups).where(eq(s.backups.id, id)).get();
  }

  markRestored(id: string) {
    this.db.update(s.backups).set({ restoredAt: new Date().toISOString() }).where(eq(s.backups.id, id)).run();
  }

  /* ----------------------------- settings ----------------------------- */

  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.select().from(s.settings).where(eq(s.settings.key, key)).get();
    return r ? (JSON.parse(r.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown) {
    const v = JSON.stringify(value);
    this.db.insert(s.settings).values({ key, value: v }).onConflictDoUpdate({ target: s.settings.key, set: { value: v } }).run();
  }

  allSettings(): Record<string, unknown> {
    return Object.fromEntries(this.db.select().from(s.settings).all().map((r) => [r.key, JSON.parse(r.value)]));
  }
}
