import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, drainSkippedKeyMaterial, isKeyMaterialPath, readBytesIfExists, readTextIfExists, safeJoin, walkFiles } from "@nomad/core/node";

let home: string;
const KEY = "0x" + "4f3c2a1b9d8e7f60".repeat(4);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nomad-keys-"));
  drainSkippedKeyMaterial();
  for (const [p, c] of [
    [".config/priors/agent.key", KEY],
    [".config/priors/agent-7311.key", KEY],
    [".local/state/priors-mcp/join-0xabc.json", "{}"],
    [".priors/state/state.json", "{}"],
    [".agent001/wallet.json", `{"key":"${KEY}"}`],
    ["project/agent.key", KEY],
    ["project/notes/README.md", "hello"]
  ] as const) {
    mkdirSync(join(home, p, ".."), { recursive: true });
    writeFileSync(join(home, p), c, { mode: 0o600 });
  }
  symlinkSync(join(home, ".config/priors/agent.key"), join(home, "project/notes/NOTES.md"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("key material", () => {
  it("recognises wallet folders, key files and symlinks into them", () => {
    for (const p of [".config/priors/agent.key", ".local/state/priors-mcp/join-0xabc.json", ".priors/state/state.json", ".agent001/wallet.json", "project/agent.key", "project/notes/NOTES.md"]) {
      expect(isKeyMaterialPath(join(home, p)), p).toBe(true);
    }
    expect(isKeyMaterialPath(join(home, "project/notes/README.md"))).toBe(false);
  });

  it("never reads them and lists them as skipped", async () => {
    expect(await readTextIfExists(join(home, ".config/priors/agent.key"))).toBeNull();
    expect(await readTextIfExists(join(home, "project/notes/NOTES.md"))).toBeNull();
    expect(await readBytesIfExists(join(home, ".agent001/wallet.json"))).toBeNull();
    expect(await readTextIfExists(join(home, "project/notes/README.md"))).toBe("hello");
    const walked = await walkFiles(join(home, "project"));
    expect(walked).toEqual(["notes/README.md"]);
    const skipped = drainSkippedKeyMaterial();
    expect(skipped).toContain(join(home, ".config/priors/agent.key"));
    expect(skipped).toContain(join(home, "project/agent.key"));
    expect(drainSkippedKeyMaterial()).toEqual([]);
  });

  it("refuses to write into them", async () => {
    await expect(atomicWrite(join(home, ".priors/x"), "data")).rejects.toThrow(/wallet keys/);
    expect(() => safeJoin(home, ".config/priors/new.json")).toThrow(/wallet keys/);
  });
});
