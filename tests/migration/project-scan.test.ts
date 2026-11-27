import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPlatforms } from "@nomad/adapters";

const made: string[] = [];
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "nomad-project-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scanning a project folder", () => {
  it("finds a Cursor setup kept inside a project, which has no default location", async () => {
    const dir = project();
    mkdirSync(join(dir, ".cursor/rules"), { recursive: true });
    writeFileSync(join(dir, ".cursor/rules/main.mdc"), "---\ndescription: test\nalwaysApply: true\n---\nBe careful.\n");
    writeFileSync(join(dir, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { zerolux: { url: "https://zerolux.fun/mcp" } } }));
    expect((await scanPlatforms([])).some((p) => p.adapter === "cursor" && p.root === dir)).toBe(false);
    const found = await scanPlatforms([], dir);
    const cursor = found.find((p) => p.adapter === "cursor" && p.root === dir);
    expect(cursor?.agents.length).toBeGreaterThan(0);
  });

  it("finds nothing extra in a folder with no project setup", async () => {
    const dir = project();
    expect((await scanPlatforms([], dir)).filter((p) => p.root === dir)).toEqual([]);
  });
});
