import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyUpdate, assetName, checksumFor, currentInstall, newer } from "../../apps/cli/src/install";

/** `nomad update` for Nomad installed from thenomad.website: checked, then switched, never half done. */

const win = process.platform === "win32";
const TARGET = win ? "windows-x64" : "linux-x64";
const NODE = win ? "node.exe" : "node";
let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "nomad-install-"))));
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** The bundle layout, with a real runtime: its nomad.js prints the version it was built for. */
function fakeApp(at: string, version: string, runtime = true) {
  mkdirSync(join(at, "node_modules/thenomad/dist"), { recursive: true });
  mkdirSync(join(at, "launcher"), { recursive: true });
  if (runtime) copyFileSync(process.execPath, join(at, NODE));
  else writeFileSync(join(at, NODE), "");
  writeFileSync(join(at, "node_modules/thenomad/dist/nomad.js"), `console.log(${JSON.stringify(version)});\n`);
  writeFileSync(join(at, "launcher", win ? "nomad.cmd" : "nomad"), `launcher ${version}\n`);
}

function fakeInstall(version: string) {
  const root = join(dir, "nomad");
  fakeApp(join(root, "app", version), version, false);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "current"), version);
  writeFileSync(join(root, "install.json"), JSON.stringify({ by: "nomad-installer", target: TARGET, version }));
  return { root, target: TARGET, version };
}

// One release archive for 0.4.3, built once (it holds a copy of the Node.js runtime).
let shared: string;
let archive: Buffer;
beforeAll(() => {
  shared = mkdtempSync(join(tmpdir(), "nomad-release-"));
  fakeApp(join(shared, "app"), "0.4.3");
  const file = join(shared, assetName(TARGET));
  const tar = win ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const r = spawnSync(tar, [win ? "-a" : "-z", "-cf", file, "-C", join(shared, "app"), NODE, "node_modules", "launcher"]);
  expect(r.status, String(r.stderr)).toBe(0);
  archive = readFileSync(file);
}, 120000);
afterAll(() => rmSync(shared, { recursive: true, force: true }));

function release(tamper = false) {
  const sum = createHash("sha256").update(tamper ? Buffer.from("something else") : archive).digest("hex");
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (url.endsWith("/SHA256SUMS")) return new Response(`${sum}  ${assetName(TARGET)}\n`);
    if (url.endsWith(`/${assetName(TARGET)}`)) return new Response(new Uint8Array(archive));
    return new Response("not found", { status: 404 });
  });
  return calls;
}

describe("installer updates", () => {
  it("knows the asset names and compares versions", () => {
    expect(assetName("windows-arm64")).toBe("nomad-windows-arm64.zip");
    expect(assetName("macos-x64")).toBe("nomad-macos-x64.tar.gz");
    expect(newer("0.4.10", "0.4.9")).toBe(true);
    expect(newer("0.4.2", "0.4.2")).toBe(false);
    expect(newer("0.3.9", "0.4.0")).toBe(false);
    const sums = `${"a".repeat(64)}  nomad-linux-x64.tar.gz\n${"B".repeat(64)} *nomad-windows-x64.zip\r\n`;
    expect(checksumFor(sums, "nomad-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksumFor(sums, "nomad-windows-x64.zip")).toBe("b".repeat(64));
    expect(checksumFor(sums, "nomad-macos-x64.tar.gz")).toBeNull();
  });

  it("recognises only installs the installer made", () => {
    const install = fakeInstall("0.4.2");
    expect(currentInstall(join(install.root, "app/0.4.2", NODE))).toEqual(install);
    expect(currentInstall(process.execPath)).toBeNull();
    writeFileSync(join(install.root, "install.json"), JSON.stringify({ by: "someone-else", target: TARGET }));
    expect(currentInstall(join(install.root, "app/0.4.2", NODE))).toBeNull();
  });

  it("downloads, checks the fingerprint, then switches and removes the old version", async () => {
    const install = fakeInstall("0.4.2");
    const calls = release();
    await expect(applyUpdate(install, "0.4.3")).resolves.toBe("0.4.3");
    const base = "https://github.com/kadiri-seer/nomad/releases/download/v0.4.3";
    expect(calls).toEqual([`${base}/SHA256SUMS`, `${base}/${assetName(TARGET)}`]);
    expect(readFileSync(join(install.root, "current"), "utf8")).toBe("0.4.3");
    expect(JSON.parse(readFileSync(join(install.root, "install.json"), "utf8"))).toMatchObject({ by: "nomad-installer", version: "0.4.3" });
    expect(readFileSync(join(install.root, "bin", win ? "nomad.cmd" : "nomad"), "utf8")).toContain("launcher 0.4.3");
    expect(existsSync(join(install.root, "app/0.4.2"))).toBe(false);
    expect(existsSync(join(install.root, "app/0.4.3", NODE))).toBe(true);
    expect(readdirSync(install.root).filter((f) => f.startsWith("tmp-") || f.startsWith("current."))).toEqual([]);
  }, 120000);

  it("a download that does not match its fingerprint changes nothing", async () => {
    const install = fakeInstall("0.4.2");
    release(true);
    await expect(applyUpdate(install, "0.4.3")).rejects.toThrow("does not match its published fingerprint");
    expect(readFileSync(join(install.root, "current"), "utf8")).toBe("0.4.2");
    expect(existsSync(join(install.root, "app/0.4.2", NODE))).toBe(true);
    expect(existsSync(join(install.root, "app/0.4.3"))).toBe(false);
  }, 120000);

  it("a version that does not start as the version asked for changes nothing", async () => {
    const install = fakeInstall("0.4.2");
    release(); // the archive says 0.4.3 when run, while 0.4.4 is asked for
    await expect(applyUpdate(install, "0.4.4")).rejects.toThrow("did not start correctly");
    expect(readFileSync(join(install.root, "current"), "utf8")).toBe("0.4.2");
    expect(existsSync(join(install.root, "app/0.4.4"))).toBe(false);
    expect(readdirSync(install.root).filter((f) => f.startsWith("tmp-"))).toEqual([]);
  }, 120000);

  it("refuses a version name that is not a version", async () => {
    const install = fakeInstall("0.4.2");
    await expect(applyUpdate(install, "../../evil")).rejects.toThrow("Not a version");
  });
});

describe("update and uninstall outside the installer", () => {
  const CLI = resolve(__dirname, "../../apps/cli/src/index.ts");
  const TSX = resolve(__dirname, "../../node_modules/tsx/dist/cli.mjs");
  const run = (args: string[]) => spawnSync(process.execPath, [TSX, CLI, ...args], { env: { ...process.env, NOMAD_HOME: join(dir, ".nomad"), NO_COLOR: "1", npm_command: "" }, encoding: "utf8", timeout: 60000 });

  it("point to npm and change nothing", () => {
    const u = run(["update"]);
    expect(u.status).toBe(0);
    expect(u.stderr).toContain("npm install -g thenomad@latest");
    const x = run(["uninstall", "--yes"]);
    expect(x.status).toBe(0);
    expect(x.stderr).toContain("npm uninstall -g thenomad");
  });
});
