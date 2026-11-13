import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { fromUtf8, sha256, shortId } from "@nomad/core";
import { assertNoSymlinks, atomicWrite, displayPath, ensureDir, isKeyMaterialPath } from "@nomad/core/node";
import type { NomadStore } from "@nomad/storage";

export interface BackupFileEntry {
  root: string;
  abs: string;
  existed: boolean;
  sha256: string | null;
  mode: number | null;
  stored: string | null;
}

export interface BackupManifest {
  id: string;
  kind: "pre-migration" | "agent-snapshot" | "pre-restore" | "pre-sync";
  createdAt: string;
  operationId: string | null;
  agentId: string | null;
  description: string;
  files: BackupFileEntry[];
}

/** Copy the current state of files (including "did not exist") into the backup store. */
export async function createBackup(
  store: NomadStore,
  files: Array<{ root: string; abs: string }>,
  meta: { kind: BackupManifest["kind"]; operationId?: string | null; agentId?: string | null; description: string }
): Promise<BackupManifest> {
  const id = shortId("bk");
  const dir = join(store.home, "backups", id);
  await ensureDir(join(dir, "files"));
  const manifest: BackupManifest = { id, kind: meta.kind, createdAt: new Date().toISOString(), operationId: meta.operationId ?? null, agentId: meta.agentId ?? null, description: meta.description, files: [] };
  let n = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.abs)) continue;
    seen.add(f.abs);
    if (isKeyMaterialPath(f.abs)) continue; // never copy wallet keys, even into a backup
    try {
      const st = await fsp.lstat(f.abs);
      if (!st.isFile()) continue;
      const data = await fsp.readFile(f.abs);
      const stored = `files/${String(n++).padStart(5, "0")}`;
      await fsp.writeFile(join(dir, stored), data, { mode: 0o600 });
      manifest.files.push({ root: f.root, abs: f.abs, existed: true, sha256: sha256(new Uint8Array(data)), mode: st.mode & 0o777, stored });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      manifest.files.push({ root: f.root, abs: f.abs, existed: false, sha256: null, mode: null, stored: null });
    }
  }
  await fsp.writeFile(join(dir, "backup.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  store.addBackup({ id, operationId: meta.operationId, agentId: meta.agentId, kind: meta.kind, path: dir, fileCount: manifest.files.length, description: meta.description });
  return manifest;
}

export async function loadBackup(store: NomadStore, id: string): Promise<BackupManifest> {
  const row = store.getBackup(id);
  if (!row) throw new Error(`Backup ${id} not found`);
  return JSON.parse(await fsp.readFile(join(row.path, "backup.json"), "utf8"));
}

export interface RestoreItem {
  path: string;
  abs: string;
  action: "restore" | "delete" | "unchanged" | "skip";
  reason?: string;
  diff?: string;
}

export interface RestorePreview {
  backupId: string;
  createdAt: string;
  description: string;
  items: RestoreItem[];
  changes: number;
}

async function current(abs: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await fsp.readFile(abs));
  } catch {
    return null;
  }
}

/** Show what restoring a backup would change. Nothing is written. */
export async function previewRestore(store: NomadStore, id: string): Promise<RestorePreview> {
  const m = await loadBackup(store, id);
  const row = store.getBackup(id)!;
  const items: RestoreItem[] = [];
  for (const f of m.files) {
    const now = await current(f.abs);
    const nowHash = now ? sha256(now) : null;
    if (f.existed) {
      if (nowHash === f.sha256) items.push({ path: displayPath(f.abs), abs: f.abs, action: "unchanged" });
      else {
        const saved = new Uint8Array(await fsp.readFile(join(row.path, f.stored!)));
        items.push({
          path: displayPath(f.abs),
          abs: f.abs,
          action: "restore",
          diff: createTwoFilesPatch(displayPath(f.abs), displayPath(f.abs), now ? fromUtf8(now) : "", fromUtf8(saved), "current", "backup", { context: 2 }).split("\n").slice(0, 200).join("\n")
        });
      }
    } else if (now) {
      const rec = store.lastWrite(f.abs);
      if (rec && rec.sha256 === nowHash) items.push({ path: displayPath(f.abs), abs: f.abs, action: "delete", reason: "Created by Nomad and unchanged since" });
      else items.push({ path: displayPath(f.abs), abs: f.abs, action: "skip", reason: "Did not exist before, but was edited since. Left in place." });
    } else items.push({ path: displayPath(f.abs), abs: f.abs, action: "unchanged" });
  }
  return { backupId: id, createdAt: m.createdAt, description: m.description, items, changes: items.filter((i) => i.action === "restore" || i.action === "delete").length };
}

/** Restore a backup. The current state is backed up first, so a restore can be undone. */
export async function restoreBackup(store: NomadStore, id: string): Promise<{ preview: RestorePreview; safetyBackup: string }> {
  const preview = await previewRestore(store, id);
  const m = await loadBackup(store, id);
  const row = store.getBackup(id)!;
  const affected = m.files.filter((f) => preview.items.find((i) => i.abs === f.abs && (i.action === "restore" || i.action === "delete")));
  const safety = await createBackup(store, affected.map((f) => ({ root: f.root, abs: f.abs })), { kind: "pre-restore", agentId: m.agentId, description: `State before restoring ${id}` });
  for (const f of affected) {
    const item = preview.items.find((i) => i.abs === f.abs)!;
    assertNoSymlinks(f.root, f.abs);
    if (item.action === "restore") {
      const saved = new Uint8Array(await fsp.readFile(join(row.path, f.stored!)));
      await atomicWrite(f.abs, saved, f.mode ?? undefined);
      store.forgetWrite(f.abs);
    } else if (item.action === "delete") {
      await fsp.rm(f.abs, { force: true });
      store.forgetWrite(f.abs);
    }
  }
  store.markRestored(id);
  return { preview, safetyBackup: safety.id };
}
