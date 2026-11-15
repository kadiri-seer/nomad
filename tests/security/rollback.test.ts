import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, utf8 } from "@nomad/core";
import { applyOperations, type FileOperation } from "@nomad/migration";

/** A move that fails partway puts every file back as it was, permissions included. */

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "nomad-rollback-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function op(name: string, before: string | null, after: string, beforeHash = before === null ? null : sha256(utf8(before))): FileOperation {
  return {
    root: dir,
    rel: name,
    abs: join(dir, name),
    display: name,
    action: before === null ? "create" : "update",
    strategy: "replace",
    component: "tools",
    description: name,
    before: before === null ? null : utf8(before),
    after: utf8(after),
    beforeHash,
    afterHash: sha256(utf8(after)),
    conflicts: [],
    userModified: false,
    replacesForeign: false,
    recordKey: name,
    recordHash: null
  } as FileOperation;
}

describe.runIf(process.platform !== "win32")("rollback", () => {
  it("restores a private file as private, a shared file as shared, and removes new files", async () => {
    writeFileSync(join(dir, "private.json"), '{"apiKey":"old"}');
    chmodSync(join(dir, "private.json"), 0o600);
    writeFileSync(join(dir, "shared.md"), "old notes");
    chmodSync(join(dir, "shared.md"), 0o644);
    writeFileSync(join(dir, "changed.json"), "edited after the preview");
    const ops = [op("private.json", '{"apiKey":"old"}', '{"apiKey":"new"}'), op("shared.md", "old notes", "new notes"), op("new.md", null, "fresh"), op("changed.json", "as previewed", "x")];
    await expect(applyOperations(ops)).rejects.toThrow("changed after the preview was created");
    expect(readFileSync(join(dir, "private.json"), "utf8")).toBe('{"apiKey":"old"}');
    expect(statSync(join(dir, "private.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "shared.md"), "utf8")).toBe("old notes");
    expect(statSync(join(dir, "shared.md")).mode & 0o777).toBe(0o644);
    expect(existsSync(join(dir, "new.md"))).toBe(false);
  });
});
