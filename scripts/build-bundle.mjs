#!/usr/bin/env node
// Builds the Nomad bundle for the system this runs on: the npm package as published, its
// dependencies, the prebuilt database module, and the Node.js runtime running this script.
// The one-line installers (scripts/install) download these from the GitHub release.
//
//   node scripts/prepare-npm.mjs && (cd release/npm && npm pack)
//   node scripts/build-bundle.mjs release/npm/thenomad-<version>.tgz
//
// Output: release/bundles/nomad-<target>.zip (Windows) or .tar.gz (Mac, Linux), where target is
// windows-x64, windows-arm64, macos-x64, macos-arm64, linux-x64 or linux-arm64.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tgz = process.argv[2] ? resolve(process.argv[2]) : "";
if (!tgz || !existsSync(tgz)) {
  console.error("Usage: node scripts/build-bundle.mjs <path to thenomad-x.y.z.tgz>");
  process.exit(2);
}

const os = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform];
const arch = { x64: "x64", arm64: "arm64" }[process.arch];
if (!os || !arch) throw new Error(`No bundle for ${process.platform}-${process.arch}.`);
const target = `${os}-${arch}`;
const win = os === "windows";
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) throw new Error(`Bundles need Node.js 22 or newer to run on; this is ${process.version}.`);

const version = JSON.parse(readFileSync(join(repo, "apps/cli/package.json"), "utf8")).version;
const out = join(repo, "release/bundles");
const stage = join(repo, "release/bundle-stage", target);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(out, { recursive: true });

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.error}).`);
};
// npm, run with this Node.js directly (no shell, so no quoting surprises on Windows).
const npmCli = [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find(existsSync);
if (!npmCli) throw new Error("npm was not found next to this Node.js.");

// 1. The package and its dependencies, exactly as npm installs them, without install scripts.
writeFileSync(join(stage, "package.json"), JSON.stringify({ private: true }) + "\n");
sh(process.execPath, [npmCli, "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tgz], { cwd: stage });
rmSync(join(stage, "package.json"));
rmSync(join(stage, "node_modules", ".bin"), { recursive: true, force: true });
rmSync(join(stage, "node_modules", ".package-lock.json"), { force: true });

// 2. The prebuilt database module for this system and this Node.js version. Building it from
//    source instead would tie the bundle to this machine, so a missing prebuild is an error.
const sqlite = join(stage, "node_modules", "better-sqlite3");
sh(process.execPath, [join(stage, "node_modules", "prebuild-install", "bin.js"), "--verbose"], { cwd: sqlite });
if (!existsSync(join(sqlite, "build", "Release", "better_sqlite3.node"))) throw new Error("The prebuilt database module is missing.");
for (const d of ["deps", "src"]) rmSync(join(sqlite, d), { recursive: true, force: true });

// 3. The runtime, with its license.
const runtime = join(stage, win ? "node.exe" : "node");
copyFileSync(process.execPath, runtime);
if (!win) chmodSync(runtime, 0o755);
const license = [join(dirname(process.execPath), "LICENSE"), join(dirname(process.execPath), "..", "LICENSE")].find(existsSync);
if (!license) throw new Error("Node.js LICENSE not found next to the runtime.");
copyFileSync(license, join(stage, "NODE-LICENSE"));

// 4. Launchers, uninstaller and icon for this system.
const launcher = join(stage, "launcher");
mkdirSync(launcher);
const from = join(repo, "scripts/install", win ? "windows" : "unix");
const files = win ? ["nomad.cmd", "nomad-app.cmd", "uninstall.ps1"] : ["nomad", "uninstall.sh", ...(os === "macos" ? ["nomad-app.command"] : [])];
for (const f of files) {
  copyFileSync(join(from, f), join(launcher, f));
  if (!win) chmodSync(join(launcher, f), 0o755);
}
const icon = { windows: "nomad.ico", macos: "nomad.icns", linux: "nomad.png" }[os];
copyFileSync(join(repo, "scripts/install/assets", icon), join(launcher, icon));
writeFileSync(join(stage, "VERSION"), version + "\n");

// 5. Check it runs on its own: the version, and the database (the native part).
const cli = join(stage, "node_modules", "thenomad", "dist", "nomad.js");
const got = execFileSync(runtime, [cli, "--version"], { encoding: "utf8" }).trim();
if (got !== version) throw new Error(`The bundle reports ${got}, expected ${version}.`);
const home = mkdtempSync(join(tmpdir(), "nomad-bundle-"));
try {
  execFileSync(runtime, [cli, "list", "--json"], { env: { ...process.env, NOMAD_HOME: join(home, ".nomad"), NOMAD_FAKE_HOME: home }, encoding: "utf8" });
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log(`Bundle runs: Nomad ${got} on Node.js ${process.version}, ${target}.`);

// 6. Pack. Windows tar (bsdtar) writes zip files; entries are listed so none start with "./".
const entries = [basename(runtime), "NODE-LICENSE", "VERSION", "launcher", "node_modules"];
const file = join(out, `nomad-${target}.${win ? "zip" : "tar.gz"}`);
rmSync(file, { force: true });
if (win) sh(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-cf", file, "-C", stage, ...entries]);
else sh("tar", ["-czf", file, "-C", stage, ...entries]);
const sum = createHash("sha256").update(readFileSync(file)).digest("hex");
writeFileSync(`${file}.sha256`, `${sum}  ${basename(file)}\n`);
console.log(`${basename(file)}  ${(readFileSync(file).length / 1048576).toFixed(1)} MB  sha256 ${sum}`);
