import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  sourcePlatform: text("source_platform").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  currentVersion: integer("current_version").notNull().default(0),
  currentHash: text("current_hash"),
  duplicatedFrom: text("duplicated_from")
});

export const versions = sqliteTable(
  "versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id").notNull(),
    version: integer("version").notNull(),
    hash: text("hash").notNull(),
    createdAt: text("created_at").notNull(),
    reason: text("reason").notNull(),
    operationId: text("operation_id"),
    platform: text("platform")
  },
  (t) => [uniqueIndex("versions_agent_version").on(t.agentId, t.version)]
);

export const locations = sqliteTable(
  "locations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id").notNull(),
    adapter: text("adapter").notNull(),
    root: text("root").notNull(),
    nativeId: text("native_id").notNull(),
    lastHash: text("last_hash"),
    lastSeenAt: text("last_seen_at").notNull(),
    role: text("role").notNull().default("copy")
  },
  (t) => [uniqueIndex("locations_unique").on(t.adapter, t.root, t.nativeId), index("locations_agent").on(t.agentId)]
);

export const operations = sqliteTable("operations", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  agentId: text("agent_id"),
  source: text("source"),
  destination: text("destination"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  receipt: text("receipt").notNull()
});

export const writtenFiles = sqliteTable("written_files", {
  path: text("path").primaryKey(),
  sha256: text("sha256").notNull(),
  agentId: text("agent_id"),
  operationId: text("operation_id"),
  writtenAt: text("written_at").notNull()
});

export const backups = sqliteTable("backups", {
  id: text("id").primaryKey(),
  operationId: text("operation_id"),
  agentId: text("agent_id"),
  kind: text("kind").notNull(),
  createdAt: text("created_at").notNull(),
  path: text("path").notNull(),
  fileCount: integer("file_count").notNull(),
  description: text("description"),
  restoredAt: text("restored_at")
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});

export const DDL = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, source_platform TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, current_version INTEGER NOT NULL DEFAULT 0,
  current_hash TEXT, duplicated_from TEXT
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL,
  created_at TEXT NOT NULL, reason TEXT NOT NULL, operation_id TEXT, platform TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS versions_agent_version ON versions(agent_id, version);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, adapter TEXT NOT NULL, root TEXT NOT NULL,
  native_id TEXT NOT NULL, last_hash TEXT, last_seen_at TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'copy'
);
CREATE UNIQUE INDEX IF NOT EXISTS locations_unique ON locations(adapter, root, native_id);
CREATE INDEX IF NOT EXISTS locations_agent ON locations(agent_id);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent_id TEXT, source TEXT, destination TEXT, status TEXT NOT NULL,
  created_at TEXT NOT NULL, receipt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS written_files (
  path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, agent_id TEXT, operation_id TEXT, written_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY, operation_id TEXT, agent_id TEXT, kind TEXT NOT NULL, created_at TEXT NOT NULL,
  path TEXT NOT NULL, file_count INTEGER NOT NULL, description TEXT, restored_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
