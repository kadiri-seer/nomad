import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDocument } from "@nomad/core";
import { createZip, writeNomadPack } from "@nomad/archive";
import { emptyDir, setup, type Env } from "../helpers";

/** A package nobody you trust signed gets a clear warning before anything moves. */

const CLI = resolve(__dirname, "../../apps/cli/src/index.ts");
const TSX_CLI = resolve(__dirname, "../../node_modules/tsx/dist/cli.mjs");

let env: Env;
beforeEach(() => (env = setup()));
afterEach(() => env.cleanup());

const WARN = "This package is not signed, so Nomad cannot tell who made it.";

describe("unsigned packages", () => {
  it("an unsigned package is named in the notes and the plan", async () => {
    const d = createDocument({ name: "Gift", platform: "generic" });
    d.instructions.push({ id: "main", kind: "agent", content: "Be helpful." });
    const pkg = join(env.home, "gift.nomad");
    writeFileSync(pkg, createZip(writeNomadPack(d).files));
    const plan = await env.nomad.plan({ source: { kind: "package", path: pkg }, destination: { adapter: "claude-code", root: emptyDir(env.home, "a/.claude") } });
    expect(plan.source.signer).toBe("unsigned");
    expect(plan.notes.some((n) => n.level === "warning" && n.message.startsWith(WARN))).toBe(true);
    // The information note it had before stays as it was.
    expect(plan.notes.some((n) => n.level === "info" && n.message === "Not signed")).toBe(true);

    const r = spawnSync(process.execPath, [TSX_CLI, CLI, "migrate", "--from", pkg, "--to", "claude-code", "--dest-dir", emptyDir(env.home, "b/.claude"), "--dry-run"], { env: { ...process.env, NOMAD_FAKE_HOME: env.home, NOMAD_HOME: env.nomadHome, NO_COLOR: "1" }, encoding: "utf8", timeout: 60000 });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain("Not signed: Nomad cannot tell who made this package.");
  });

  it("a package you signed yourself, and an agent from this computer, get no such warning", async () => {
    const exp = await env.nomad.exportAgent({ kind: "location", adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, { outPath: join(env.home, "mine.nomad"), sign: true });
    const plan = await env.nomad.plan({ source: { kind: "package", path: exp.path! }, destination: { adapter: "claude-code", root: emptyDir(env.home, "c/.claude") } });
    expect(plan.source.signer).toBe("you");
    expect(plan.notes.map((n) => n.message).join("\n")).not.toContain("cannot tell who made it");
    const own = await env.nomad.plan({ source: { kind: "location", adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" }, destination: { adapter: "claude-code", root: emptyDir(env.home, "d/.claude") } });
    expect(own.source.signer).toBeUndefined();
  });
});
