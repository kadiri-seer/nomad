import { Command, Option } from "commander";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { COMPONENT_CATEGORIES, jsonSchemas, type ComponentCategory } from "@nomad/schema";
import { NOMAD_VERSION, NomadError, SUPPORT_DESCRIPTIONS } from "@nomad/core";
import { displayPath, makeTempDir, nomadHome, resolveRoot } from "@nomad/core/node";
import { Nomad, parseSource, type Approvals, type MigrationPlan } from "@nomad/migration";
import { analyzeCompatibility } from "@nomad/compatibility";
import { findAdapter, getAdapter, listAdapters } from "@nomad/adapters";
import type { SourceSpec } from "@nomad/migration";
import { approvalQuestion, bold, comparisonText, compatibilityText, dim, docText, green, planText, print, receiptText, red, restoreText, summaryText, table, yellow, type Output } from "./format";
import { remoteMigrate } from "./remote";

export const EXIT = { ok: 0, error: 1, usage: 2, approval: 3, invalid: 4, verification: 5, rolledBack: 6 } as const;

const program = new Command();
program
  .name("nomad")
  .description("Move, preserve and manage AI agents across platforms.")
  .version(NOMAD_VERSION)
  .option("--json", "machine readable output")
  .option("-q, --quiet", "print nothing except errors")
  .option("-v, --verbose", "show details and diffs")
  .option("--home <dir>", "Nomad data directory (default ~/.nomad)");
program.addHelpText(
  "after",
  `
Start here:
  nomad                              guided: pick an agent and where it goes
  nomad move openclaw codex          the same in one line, with a short preview first
  nomad move openclaw ./me.nomad     save to a file you can share or keep
  nomad move ./me.nomad claude-code  open that file somewhere else`
);

function out(): Output {
  const o = program.opts();
  return { json: !!o.json, quiet: !!o.quiet, verbose: !!o.verbose };
}

function engine(): Nomad {
  const home = program.opts().home;
  if (home) process.env.NOMAD_HOME = resolve(home);
  return new Nomad({ home: home ? resolve(home) : nomadHome() });
}

function components(list?: string): ComponentCategory[] | undefined {
  if (!list) return undefined;
  const items = list.split(",").map((s) => s.trim()).filter(Boolean);
  for (const i of items) if (!(COMPONENT_CATEGORIES as readonly string[]).includes(i)) throw new NomadError(`Unknown component "${i}".`, "usage", `Choose from: ${COMPONENT_CATEGORIES.join(", ")}`);
  return items as ComponentCategory[];
}

async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const a = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim();
  rl.close();
  return a === "" ? defaultYes : /^y(es)?$/i.test(a);
}

async function run(fn: (nomad: Nomad) => Promise<number | void>) {
  let nomad: Nomad | undefined;
  let code: number = EXIT.ok;
  try {
    nomad = engine();
    code = (await fn(nomad)) ?? EXIT.ok;
  } catch (e) {
    const err = e as Error & { code?: string; hint?: string };
    if (out().json) process.stdout.write(JSON.stringify({ error: err.message, code: err.code ?? "error", hint: err.hint }) + "\n");
    else {
      process.stderr.write(red("Error: ") + err.message + "\n");
      if (err.hint) process.stderr.write(dim(err.hint) + "\n");
      if (out().verbose && !(e instanceof NomadError)) process.stderr.write(dim(err.stack ?? "") + "\n");
    }
    code = err.code === "usage" ? EXIT.usage : err.code === "approval-required" ? EXIT.approval : err.code === "invalid-package" ? EXIT.invalid : EXIT.error;
  } finally {
    nomad?.close();
  }
  process.exitCode = code;
}

/** Shared: preview, ask once, execute. Used by move, migrate, import --to and sync. */
export async function previewAndApply(nomad: Nomad, plan: MigrationPlan, o: { dryRun?: boolean; yes?: boolean; details?: boolean; approveReplace?: boolean; approveModified?: boolean; approvePermissions?: boolean }): Promise<number> {
  const output = out();
  const show = () => (o.details || output.verbose ? planText(plan, output.verbose) : summaryText(plan));
  if (o.dryRun || plan.blocked.length) {
    print(output, () => [...show(), ...(o.dryRun && !plan.blocked.length ? ["", dim("Preview only. Run again without --dry-run to apply.")] : [])], { plan });
    return plan.blocked.length ? EXIT.error : EXIT.ok;
  }
  if (!output.json) print(output, show, null);
  const approvals: Approvals = { replace: o.approveReplace, overwriteModified: o.approveModified, broaderPermissions: o.approvePermissions };
  const missing = plan.approvalsRequired.filter((a) => (a === "replace" && !approvals.replace) || (a === "overwrite-modified" && !approvals.overwriteModified) || (a === "broader-permissions" && !approvals.broaderPermissions));
  if (o.yes || !process.stdin.isTTY) {
    if (missing.length) {
      const flags = missing.map((m) => (m === "replace" ? "--approve-replace" : m === "overwrite-modified" ? "--approve-modified" : "--approve-permissions"));
      throw new NomadError(`This migration needs explicit approval: ${missing.join(", ")}.`, "approval-required", `Review the preview, then add ${flags.join(" ")}.`);
    }
    if (!o.yes) throw new NomadError("Not running interactively.", "approval-required", "Add --yes to apply without a prompt, or --dry-run to preview.");
  } else {
    // One question, in plain language, covers everything that needs approval.
    const heads = missing.length ? approvalQuestion(plan) : null;
    if (heads) process.stderr.write("\n" + yellow(heads) + "\n");
    if (!(await confirm(bold("\nGo ahead?"), !heads))) {
      process.stderr.write("Nothing was changed.\n");
      return EXIT.approval;
    }
    for (const m of missing) {
      if (m === "replace") approvals.replace = true;
      if (m === "overwrite-modified") approvals.overwriteModified = true;
      if (m === "broader-permissions") approvals.broaderPermissions = true;
    }
  }
  const receipt = await nomad.execute(plan.id, approvals, { token: plan.token });
  print(output, () => (o.details || output.verbose ? receiptText(receipt) : shortReceipt(receipt)), { plan, receipt });
  return receipt.status === "success" ? EXIT.ok : receipt.status === "verification-failed" ? EXIT.verification : EXIT.rolledBack;
}

function shortReceipt(r: import("@nomad/migration").MigrationReceipt): string[] {
  if (r.status !== "success") return receiptText(r);
  return [
    "",
    green("Done.") + ` ${r.agent.name} is in ${findAdapter(r.destination.adapter)?.info.displayName ?? r.destination.adapter} and checked (${r.verification.length} checks passed).`,
    ...(r.manualSteps.length ? ["", bold("Your turn:"), ...r.manualSteps.map((s, i) => `  ${i + 1}. ${s}`)] : []),
    ...(r.backupId ? ["", dim(`Changed your mind? nomad restore ${r.backupId}`)] : [])
  ];
}

const approvalOptions = (cmd: Command) =>
  cmd
    .option("--dry-run", "only show the preview")
    .option("--details", "show the full preview: every category, file and diff")
    .option("-y, --yes", "apply without asking (non-interactive)")
    .option("--approve-replace", "allow replacing content Nomad did not write")
    .option("--approve-modified", "allow overwriting files edited after Nomad wrote them")
    .option("--approve-permissions", "allow a destination policy broader than the current one");

/* ------------------------------ discovery ------------------------------ */

program
  .command("adapters")
  .description("list supported platforms and what each can transfer")
  .option("--platform <id>", "show one platform in detail")
  .action((o) =>
    run(async (nomad) => {
      const infos = nomad.adapters();
      if (o.platform) {
        const a = getAdapter(o.platform).info;
        print(out(), () => [
          bold(a.displayName) + `  [${a.support}] ${dim(SUPPORT_DESCRIPTIONS[a.support])}`,
          a.description,
          `Formats: ${a.configFormats.join(", ")}   Default location: ${a.defaultLocations.join(", ") || "none"}`,
          "",
          table(Object.entries(a.capabilities).map(([k, v]) => [k, v.read, v.write, dim(v.notes ?? "")]), ["Category", "Read", "Write", "Notes"]),
          "",
          ...a.limitations.map((l) => `- ${l}`)
        ], a);
        return;
      }
      print(out(), () => table(infos.map((a) => [a.id, a.displayName, a.support, a.category, a.defaultLocations.join(", ")]), ["Id", "Platform", "Support", "Kind", "Default location"]), infos);
    })
  );

program
  .command("scan")
  .description("find supported platforms and agents on this machine")
  .action(() =>
    run(async (nomad) => {
      const found = await nomad.scan();
      print(out(), () => (found.length ? found.flatMap((p) => [bold(`${p.displayName}`) + dim(`  ${displayPath(p.root)}`), ...p.agents.map((a) => `  ${p.adapter}:${displayPath(p.root)}#${a.nativeId}  ${a.name}${a.agentId ? dim("  in library") : ""}`)]) : "No supported platforms were found at their default locations."), found);
    })
  );

program
  .command("list")
  .description("list agents in the local library")
  .action(() =>
    run(async (nomad) => {
      const agents = nomad.listAgents();
      print(out(), () => (agents.length ? table(agents.map((a) => [a.id.slice(0, 10), a.name, `v${a.currentVersion}`, a.sourcePlatform, String(a.skills), String(a.memoryEntries), a.locations.map((l) => l.adapter).join(", ")]), ["Id", "Name", "Version", "Origin", "Skills", "Memory", "Locations"]) : 'The library is empty. Read an agent with "nomad inspect openclaw" or import a package.'), agents);
    })
  );

program
  .command("inspect <source>")
  .description("show what an agent contains (reading registers it in the library)")
  .option("--source-dir <dir>", "platform directory")
  .option("--agent <id>", "agent inside the platform")
  .option("--against <platform>", "also show compatibility with a platform")
  .action((source, o) =>
    run(async (nomad) => {
      const spec = await parseSource(nomad, source, { sourceDir: o.sourceDir, agent: o.agent });
      const loaded = await nomad.loadSource(spec);
      const compat = o.against ? analyzeCompatibility(loaded.doc, loaded.sourceAdapter?.info ?? null, getAdapter(o.against).info) : null;
      print(
        out(),
        () => [
          ...docText(loaded.doc),
          ...(loaded.scan.findings.length ? ["", yellow(`${loaded.scan.findings.length} secret(s) detected and redacted:`), ...loaded.scan.findings.map((f) => `  ${f.ruleName} in ${f.file}:${f.line}`)] : []),
          ...loaded.notes.map((n) => dim(`- ${n.message}`)),
          ...(compat ? ["", ...compatibilityText(compat)] : [])
        ],
        { doc: loaded.doc, notes: loaded.notes, secrets: loaded.scan.findings, compatibility: compat, version: loaded.version }
      );
    })
  );

program
  .command("validate <package>")
  .description("check a package (.nomad, .agentpack or .jetpack) without importing it")
  .action((pkg) =>
    run(async (nomad) => {
      const { readFileSync } = await import("node:fs");
      const r = nomad.validatePackage(new Uint8Array(readFileSync(resolve(pkg))));
      const { describeSigner } = await import("@nomad/migration");
      print(out(), () => (r.ok ? [green("Valid package") + `  ${r.doc!.name} (${r.doc!.id})`, `Format ${r.format}. ${describeSigner(r.signer)}`, `${r.fileCount} files, ${r.totalBytes} bytes`, ...r.warnings.map((w) => yellow("! ") + w), ...(r.scan?.findings.length ? [yellow(`${r.scan.findings.length} secret(s) found in the package`)] : [])] : [red("Invalid package"), ...r.issues.map((i) => `  ${i.path}: ${i.message}`)]), { ok: r.ok, format: r.format, signer: r.signer, issues: r.issues, warnings: r.warnings, info: r.info, findings: r.scan?.findings ?? [] });
      return r.ok ? EXIT.ok : EXIT.invalid;
    })
  );

/* ------------------------------ export / import ------------------------------ */

program
  .command("export <source>")
  .description("export an agent to a portable .nomad package")
  .option("-o, --out <path>", "output file or folder", ".")
  .option("--source-dir <dir>", "platform directory")
  .option("--agent <id>", "agent inside the platform")
  .option("--components <list>", `only these components (${COMPONENT_CATEGORIES.join(",")})`)
  .option("--include-files", "include knowledge and other files")
  .option("--include-secrets", "keep secret values in the package (not recommended)")
  .option("--include-sensitive-files", "keep credential files such as .env (not recommended)")
  .addOption(new Option("--format <format>", "nomad (complete) or jetpack (interchange archive for other tools)").choices(["nomad", "jetpack"]).default("nomad"))
  .option("--sign", "sign the package with your Nomad key so others can verify it came from you")
  .action((source, o) =>
    run(async (nomad) => {
      const spec = await parseSource(nomad, source, { sourceDir: o.sourceDir, agent: o.agent });
      if (o.includeSecrets && !out().json) process.stderr.write(yellow("Warning: secret values will be stored in the package. Share it only with people who may see them.\n"));
      const r = await nomad.exportAgent(spec, { outPath: resolve(o.out), includeSecrets: o.includeSecrets, includeFiles: o.includeFiles, includeSensitiveFiles: o.includeSensitiveFiles, components: components(o.components), format: o.format === "jetpack" ? "interchange" : "nomad", sign: o.sign });
      print(out(), () => [green("Exported") + `  ${r.path}`, ...(r.receipt.signedBy ? [`Signed with your key ${r.receipt.signedBy}`] : []), ...(r.receipt.notIncluded.length ? [yellow(`Not representable in this format: ${r.receipt.notIncluded.join(", ")}`)] : []), `${r.files.size} files, ${r.bytes.length} bytes`, ...(r.sanitize.redactedText || r.sanitize.strippedEnvValues.length ? [yellow(`${r.sanitize.redactedText} secret(s) redacted, ${r.sanitize.strippedEnvValues.length} credential(s) replaced by references`)] : []), ...(r.sanitize.removedFiles.length ? [yellow(`Left out credential files: ${r.sanitize.removedFiles.join(", ")}`)] : [])], r.receipt);
    })
  );

approvalOptions(
  program
    .command("import <package>")
    .description("import a package into the library, and optionally into a platform")
    .option("--to <platform>", "also write the agent to this platform")
    .option("--dest-dir <dir>", "destination directory")
    .addOption(new Option("--mode <mode>", "conflict handling").choices(["merge", "copy", "replace"]).default("merge"))
    .option("--name <name>", "name for copy mode")
    .option("--components <list>", "only these components")
).action((pkg, o) =>
  run(async (nomad) => {
    const path = resolve(pkg);
    const r = await nomad.importPackage({ path });
    if (!r.ok) {
      print(out(), () => [red("The package was rejected"), ...r.issues.map((i) => `  ${i.path}: ${i.message}`)], r);
      return EXIT.invalid;
    }
    if (!o.to) {
      print(out(), () => [green(r.recognized ? "Updated" : "Imported") + `  ${r.name} (${r.agentId}) v${r.version}`, r.signerText, ...r.warnings.map((w) => yellow("! ") + w)], r);
      return;
    }
    if (!out().json && !out().quiet) process.stderr.write(dim(`Imported ${r.name} into the library.\n`));
    const dest = o.destDir ?? getAdapter(o.to).info.defaultLocations[0];
    if (!dest) throw new NomadError(`Pass --dest-dir for ${o.to}.`, "usage");
    const plan = await nomad.plan({ kind: "import", source: { kind: "package", path }, destination: { adapter: o.to, root: resolveRoot(dest) }, mode: o.mode, targetName: o.name, components: components(o.components) });
    return previewAndApply(nomad, plan, o);
  })
);

/* ------------------------------ migrate ------------------------------ */

approvalOptions(
  program
    .command("migrate")
    .description("move an agent to another platform, with a preview before anything changes")
    .requiredOption("--from <source>", "package, platform (openclaw, claude-code:~/proj#main), folder or library agent")
    .requiredOption("--to <platform>", "destination platform id")
    .option("--source-dir <dir>", "source platform directory")
    .option("--agent <id>", "agent inside the source platform")
    .option("--dest-dir <dir>", "destination directory (default: the platform's default location)")
    .option("--dest-agent <id>", "existing agent to update at the destination")
    .addOption(new Option("--mode <mode>", "merge keeps existing data, copy creates a separate agent, replace overwrites").choices(["merge", "copy", "replace"]).default("merge"))
    .option("--keep-existing", "same as --mode merge")
    .option("--replace", "same as --mode replace")
    .option("--name <name>", "name of the new agent in copy mode")
    .option("--components <list>", `only these components (${COMPONENT_CATEGORIES.join(",")})`)
    .option("--include-files", "include knowledge files")
    .option("--include-secrets", "carry secret values (not recommended)")
).action((o) =>
  run(async (nomad) => {
    const spec = await parseSource(nomad, o.from, { sourceDir: o.sourceDir, agent: o.agent });
    const adapter = getAdapter(o.to);
    const dest = o.destDir ?? adapter.info.defaultLocations[0];
    if (!dest) throw new NomadError(`${adapter.info.displayName} needs --dest-dir (a project folder${adapter.info.support === "GUIDED" ? ", or a folder for the setup kit" : ""}).`, "usage");
    const mode = o.replace ? "replace" : o.keepExisting ? "merge" : o.mode;
    const plan = await nomad.plan({ source: spec, destination: { adapter: o.to, root: resolveRoot(dest), nativeId: o.destAgent }, mode, targetName: o.name, components: components(o.components), includeFiles: o.includeFiles, includeSecrets: o.includeSecrets });
    return previewAndApply(nomad, plan, o);
  })
);

/* ------------------------------ move (the short way) ------------------------------ */

type Destination = { kind: "file"; path: string } | { kind: "platform"; adapter: string; root: string; nativeId?: string };

/** "codex", "claude-code:~/project", "claude-code:~/project#main", or "./agent.nomad". */
export function parseDestination(spec: string): Destination {
  if (/\.(nomad|jetpack)$/i.test(spec)) return { kind: "file", path: resolve(spec.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) };
  const m = /^([a-z0-9-]+)(?::(.*?))?(?:#(.+))?$/.exec(spec);
  const adapter = m ? findAdapter(m[1]) : undefined;
  if (!adapter || !m) throw new NomadError(`"${spec}" is not a platform or a package file.`, "usage", `Use a platform (${listAdapters().map((a) => a.info.id).slice(0, 5).join(", ")}, ...), a platform with a folder such as claude-code:~/project, or a file ending in .nomad.`);
  const root = m[2] || adapter.info.defaultLocations[0] || process.cwd();
  return { kind: "platform", adapter: adapter.info.id, root: resolveRoot(root), nativeId: m[3] };
}

async function moveTo(nomad: Nomad, source: SourceSpec, dest: Destination, o: Record<string, unknown>): Promise<number> {
  if (dest.kind === "file") {
    const r = await nomad.exportAgent(source, { outPath: dest.path, includeFiles: o.includeFiles as boolean, sign: o.sign as boolean, components: components(o.components as string) });
    print(out(), () => [green("Saved") + `  ${displayPath(r.path!)}`, `${r.files.size} files, ${(r.bytes.length / 1024).toFixed(1)} KB${r.receipt.signedBy ? `, signed ${r.receipt.signedBy}` : ""}.`, ...(r.sanitize.redactedText || r.sanitize.strippedEnvValues.length ? [dim("Secrets were left out. You will reconnect them where you open it.")] : []), dim(`Open it anywhere with: nomad move ${displayPath(r.path!)} <platform>`)], r.receipt);
    return EXIT.ok;
  }
  const mode = o.copy ? "copy" : o.replace ? "replace" : "merge";
  const plan = await nomad.plan({ source, destination: { adapter: dest.adapter, root: dest.root, nativeId: dest.nativeId }, mode, targetName: o.name as string | undefined, components: components(o.components as string), includeFiles: o.includeFiles as boolean });
  return previewAndApply(nomad, plan, o);
}

approvalOptions(
  program
    .command("move <from> <to>")
    .description("move an agent in one step: nomad move openclaw codex, or nomad move openclaw ./me.nomad")
    .option("--agent <id>", "which agent, when the source has several")
    .option("--copy", "create a separate agent instead of updating a matching one")
    .option("--replace", "overwrite the destination agent")
    .option("--name <name>", "name for the copy")
    .option("--components <list>", `only these components (${COMPONENT_CATEGORIES.join(",")})`)
    .option("--include-files", "include knowledge files")
    .option("--sign", "sign the package when saving to a file")
).action((from, to, o) =>
  run(async (nomad) => moveTo(nomad, await parseSource(nomad, from, { agent: o.agent }), parseDestination(to), o))
);

/* ------------------------------ signing ------------------------------ */

program
  .command("keys")
  .description("show your signing key, and the keys you trust")
  .action(() =>
    run(async (nomad) => {
      const own = nomad.signingKey(true)!;
      const trusted = nomad.trustedKeys();
      print(out(), () => [
        (own.created ? green("Created your signing key") : bold("Your signing key")) + `  ${own.fingerprint}`,
        dim("Share this fingerprint so people can check packages you sign with --sign."),
        "",
        trusted.length ? bold("Trusted keys") : "You do not trust anyone else's key yet. Use: nomad trust <package> --name <who>",
        ...trusted.map((k) => `  ${k.fingerprint}  ${k.name}`)
      ], { key: own, trusted });
    })
  );

program
  .command("trust <package>")
  .description("trust the key that signed a package")
  .requiredOption("--name <who>", "a name for this key, such as a person or team")
  .action((pkg, o) =>
    run(async (nomad) => {
      const { readFileSync } = await import("node:fs");
      const k = nomad.trustPackageSigner(new Uint8Array(readFileSync(resolve(pkg))), o.name);
      print(out(), () => [green("Trusted") + `  ${k.fingerprint}  ${k.name}`, dim("Check this fingerprint with them through another channel.")], k);
    })
  );

program
  .command("untrust <fingerprint>")
  .description("stop trusting a key")
  .action((fp) =>
    run(async (nomad) => {
      nomad.untrust(fp);
      print(out(), () => green("Removed") + `  ${fp}`, { removed: fp });
    })
  );

/* ------------------------------ lifecycle ------------------------------ */

program
  .command("versions <agent>")
  .description("list the versions of an agent")
  .action((agent) =>
    run(async (nomad) => {
      const d = nomad.agentDetail(agent);
      print(out(), () => table(d.versions.map((v) => [`v${v.version}`, v.createdAt.replace("T", " ").slice(0, 19), v.reason, v.operationId ?? ""]), ["Version", "When", "Why", "Operation"]), d.versions);
    })
  );

program
  .command("compare [agent] [left] [right]")
  .description("compare two versions (nomad compare <agent> 1 3) or two locations (--left, --right)")
  .option("--left <source>", "platform location, e.g. openclaw:~/.openclaw#main")
  .option("--right <source>", "platform location")
  .action((agent, left, right, o) =>
    run(async (nomad) => {
      if (o.left && o.right) {
        const l = await parseSource(nomad, o.left);
        const r = await parseSource(nomad, o.right);
        if (l.kind !== "location" || r.kind !== "location") throw new NomadError("--left and --right must be platform locations.", "usage");
        const c = await nomad.compareLocations(l, r);
        print(out(), () => comparisonText(c), c);
        return;
      }
      if (!agent || !left || !right) throw new NomadError("Give an agent and two version numbers, or --left and --right.", "usage");
      const c = nomad.compareVersions(agent, Number(left), Number(right));
      print(out(), () => comparisonText(c), c);
    })
  );

program
  .command("history [agent]")
  .description("show past operations")
  .action((agent) =>
    run(async (nomad) => {
      const ops = nomad.history(agent);
      print(out(), () => (ops.length ? table(ops.map((op) => [op.createdAt.replace("T", " ").slice(0, 19), op.kind, op.status === "success" ? green(op.status) : red(op.status), op.receiptJson?.agent?.name ?? "", op.destination ?? "", op.id]), ["When", "Operation", "Status", "Agent", "Destination", "Id"]) : "No operations yet."), ops.map((o) => o.receiptJson));
    })
  );

program
  .command("receipt <operation>")
  .description("show the receipt of an operation")
  .action((id) =>
    run(async (nomad) => {
      const op = nomad.store.getOperation(id);
      if (!op) throw new NomadError(`Operation ${id} not found.`, "not-found");
      print(out(), () => (op.kind === "migrate" || op.kind === "sync" || op.kind === "import" ? (op.receiptJson.verification ? receiptText(op.receiptJson) : JSON.stringify(op.receiptJson, null, 2)) : JSON.stringify(op.receiptJson, null, 2)), op.receiptJson);
    })
  );

program
  .command("backup <agent>")
  .description("snapshot the native files of an agent at every known location")
  .action((agent) =>
    run(async (nomad) => {
      const b = await nomad.backupAgent(agent);
      print(out(), () => `${green("Backup")} ${b.id}  ${b.files.length} file(s)`, b);
    })
  );

program
  .command("backups [agent]")
  .description("list backups")
  .action((agent) =>
    run(async (nomad) => {
      const list = nomad.backups(agent);
      print(out(), () => (list.length ? table(list.map((b) => [b.id, b.kind, b.createdAt.replace("T", " ").slice(0, 19), String(b.fileCount), b.restoredAt ? "restored" : "", b.description ?? ""]), ["Id", "Kind", "When", "Files", "", "Description"]) : "No backups yet."), list);
    })
  );

program
  .command("restore <backup>")
  .description("restore files from a backup (shows a preview first)")
  .option("--dry-run", "only show the preview")
  .option("-y, --yes", "restore without asking")
  .action((id, o) =>
    run(async (nomad) => {
      const p = await nomad.previewRestore(id);
      if (o.dryRun || !p.changes) {
        print(out(), () => restoreText(p), p);
        return;
      }
      if (!out().json) print(out(), () => restoreText(p), null);
      if (!o.yes && !(await confirm("Restore these files?"))) return EXIT.approval;
      const r = await nomad.restore(id);
      print(out(), () => `${green("Restored")} ${r.preview.changes} file(s). The previous state is in backup ${r.safetyBackup}.`, r);
    })
  );

program
  .command("restore-version <agent> <version>")
  .description("make an earlier version the current library version")
  .option("-y, --yes", "do not ask")
  .action((agent, version, o) =>
    run(async (nomad) => {
      const d = nomad.agentDetail(agent);
      const target = nomad.store.versionDocument(d.agent.id, Number(version));
      if (!target) throw new NomadError("Version not found.", "not-found");
      if (!out().json) print(out(), () => comparisonText(nomad.compareVersions(agent, d.agent.currentVersion, Number(version))), null);
      if (!o.yes && !(await confirm(`Make v${version} current?`))) return EXIT.approval;
      const r = nomad.restoreVersion(agent, Number(version));
      print(out(), () => `${green("Restored")} as v${r.version}. Migrate it to a platform to apply it there.`, r);
    })
  );

program
  .command("duplicate <agent>")
  .description("copy an agent under a new identity")
  .option("--name <name>", "name of the copy")
  .action((agent, o) =>
    run(async (nomad) => {
      const r = nomad.duplicateAgent(agent, o.name);
      print(out(), () => `${green("Duplicated")} as ${r.name} (${r.agentId})`, r);
    })
  );

approvalOptions(
  program
    .command("sync <agent>")
    .description("push the agent from its primary location to its other locations (one way)")
    .option("--from <source>", "use this location as the primary")
).action((agent, o) =>
  run(async (nomad) => {
    const from = o.from ? await parseSource(nomad, o.from) : undefined;
    const { primary, plans } = await nomad.planSync(agent, { from: from?.kind === "location" ? from : undefined });
    if (!plans.length) {
      print(out(), () => "Nothing to sync: the agent has no other locations.", { plans: [] });
      return;
    }
    if (!out().json) process.stderr.write(dim(`Primary: ${primary.adapter} at ${displayPath(primary.root)}\n`));
    let worst: number = EXIT.ok;
    for (const p of plans) worst = Math.max(worst, await previewAndApply(nomad, p, o));
    return worst;
  })
);

/* ------------------------------ remote (experimental) ------------------------------ */

const remote = program.command("remote").description("experimental: migrate to another machine over SSH");
remote
  .command("push <source>")
  .description("export locally, copy over SSH, and run nomad migrate on the host")
  .requiredOption("--host <user@host>", "SSH destination")
  .requiredOption("--to <platform>", "platform on the remote host")
  .requiredOption("--dest-dir <dir>", "directory on the remote host")
  .option("--port <port>", "SSH port")
  .option("--identity <file>", "SSH private key file")
  .option("--remote-command <cmd>", "how to run Nomad remotely", "nomad")
  .addOption(new Option("--mode <mode>").choices(["merge", "copy", "replace"]).default("merge"))
  .option("--apply", "apply on the remote host (default: preview only)")
  .action((source, o) =>
    run(async (nomad) => {
      const spec = await parseSource(nomad, source);
      const tmp = await makeTempDir("nomad-remote-");
      const exp = await nomad.exportAgent(spec, { outPath: join(tmp, "agent.nomad") });
      const r = await remoteMigrate({ host: o.host, port: o.port ? Number(o.port) : undefined, identity: o.identity, remoteCommand: o.remoteCommand }, exp.path!, { to: o.to, dest: o.destDir, mode: o.mode, apply: !!o.apply });
      print(out(), () => (typeof r.result === "string" ? r.result : r.result.receipt ? receiptText(r.result.receipt) : planText(r.result.plan, out().verbose)), r.result);
      return r.code;
    })
  );

/* ------------------------------ tools ------------------------------ */

program
  .command("schema")
  .description("write the Universal Agent Format JSON Schemas")
  .option("-o, --out <dir>", "output directory", ".")
  .action((o) =>
    run(async () => {
      const s = jsonSchemas();
      const dir = resolve(o.out);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "agent-document.schema.json"), JSON.stringify(s.agentDocument, null, 2));
      writeFileSync(join(dir, "package-manifest.schema.json"), JSON.stringify(s.packageManifest, null, 2));
      print(out(), () => `Wrote schemas to ${dir}`, { dir });
    })
  );

program
  .command("settings [key] [value]")
  .description("show or change settings")
  .action((key, value) =>
    run(async (nomad) => {
      if (key && value !== undefined) {
        let v: unknown = value;
        try {
          v = JSON.parse(value);
        } catch {
          /* plain string */
        }
        nomad.setSetting(key, v);
      }
      const s = nomad.settings();
      print(out(), () => Object.entries(s).map(([k, v]) => `${k} = ${JSON.stringify(v)}`), s);
    })
  );

program
  .command("mcp")
  .description("run the Nomad MCP server on stdio")
  .option("--allow-writes", "allow executing approved migrations and restores")
  .option("--allow-replace", "allow replace mode and overwriting edited files (requires --allow-writes)")
  .action(async (o) => {
    const { startMcpServer } = await import("@nomad/mcp");
    await startMcpServer({ home: program.opts().home, allowWrites: !!o.allowWrites, allowReplace: !!o.allowReplace && !!o.allowWrites });
  });

program
  .command("ui")
  .description("open the local web interface (bound to 127.0.0.1)")
  .option("-p, --port <port>", "port", "4317")
  .option("--no-open", "do not open a browser")
  .option("--dev", "run the web app in development mode")
  .action(async (o) => {
    const here = dirname(fileURLToPath(import.meta.url));
    const webDir = [resolve(here, "../../web"), resolve(here, "../web"), resolve(process.cwd(), "apps/web")].find((d) => existsSync(join(d, "package.json")));
    if (!webDir) {
      process.stderr.write(red("The web interface is not part of this install.\n") + dim("It ships with the repository: git clone https://github.com/kadiri-seer/nomad, then pnpm install and pnpm nomad ui. Every feature is also available from the command line.\n"));
      process.exitCode = 1;
      return;
    }
    const built = existsSync(join(webDir, ".next", "BUILD_ID"));
    const token = randomBytes(24).toString("base64url");
    const env = { ...process.env, NOMAD_LOCAL: "1", NOMAD_LOCAL_TOKEN: token, NOMAD_HOME: program.opts().home ? resolve(program.opts().home) : nomadHome(), PORT: o.port };
    const mode = built && !o.dev ? "start" : "dev";
    const url = `http://127.0.0.1:${o.port}/app/session?token=${token}`;
    process.stderr.write(`${bold("Nomad")} running locally (${mode}) at ${url}\n${dim("Only this machine can reach it. Press Ctrl+C to stop.")}\n`);
    const child = spawn(process.execPath, [join(webDir, "node_modules", "next", "dist", "bin", "next"), mode, "-H", "127.0.0.1", "-p", o.port], { cwd: webDir, env, stdio: ["ignore", "inherit", "inherit"] });
    if (o.open) setTimeout(() => {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
    }, 2500);
    child.on("exit", (code) => (process.exitCode = code ?? 0));
  });

/* ------------------------------ guided mode ------------------------------ */

async function choose<T>(rl: import("node:readline/promises").Interface, question: string, items: Array<{ label: string; value: T }>): Promise<T> {
  process.stderr.write("\n" + bold(question) + "\n");
  items.forEach((it, i) => process.stderr.write(`  ${String(i + 1).padStart(2)}  ${it.label}\n`));
  for (;;) {
    const a = (await rl.question(dim(`Pick 1-${items.length} [1]: `))).trim();
    const n = a === "" ? 1 : Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1].value;
    process.stderr.write(yellow(`Type a number from 1 to ${items.length}.\n`));
  }
}

/** "nomad" with no arguments: pick an agent, pick where it goes, confirm once. */
async function guided(nomad: Nomad): Promise<number> {
  process.stderr.write(bold("Nomad") + dim(`  ${NOMAD_VERSION}`) + "\n" + dim("Looking for agents on this computer...") + "\n");
  const found = await nomad.scan();
  const library = nomad.listAgents();
  const atFound = new Set(found.flatMap((p) => p.agents.map((a) => a.agentId).filter(Boolean)));
  type Pick = { source: SourceSpec; adapter: string | null } | "file";
  const items: Array<{ label: string; value: Pick }> = [
    ...found.flatMap((p) => p.agents.map((a) => ({ label: `${a.name}  ${dim(`${p.displayName}, ${displayPath(p.root)}`)}`, value: { source: { kind: "location", adapter: p.adapter, root: p.root, nativeId: a.nativeId } as SourceSpec, adapter: p.adapter } }))),
    ...library.filter((a) => !atFound.has(a.id)).map((a) => ({ label: `${a.name}  ${dim(`saved in Nomad, v${a.currentVersion}`)}`, value: { source: { kind: "stored", agentId: a.id } as SourceSpec, adapter: null } })),
    { label: "A .nomad file", value: "file" as const }
  ];
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let source: SourceSpec;
  let from: string | null;
  let dest: Destination;
  try {
    if (items.length === 1) process.stderr.write(dim("No agents were found at the usual places. You can open a package file.") + "\n");
    const pick = await choose(rl, "Which agent?", items);
    if (pick === "file") {
      const path = resolve((await rl.question("Path to the file: ")).trim().replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
      if (!existsSync(path)) throw new NomadError(`There is no file at ${path}.`, "not-found");
      source = { kind: "package", path };
      from = null;
    } else {
      source = pick.source;
      from = pick.adapter;
    }
    const label = (a: { displayName: string; support: string }) => `${a.displayName}${a.support === "GUIDED" ? dim("  (setup kit with steps)") : a.support === "EXPERIMENTAL" ? dim("  (experimental)") : ""}`;
    const targets = listAdapters()
      .map((a) => a.info)
      .filter((a) => a.support !== "UNAVAILABLE" && a.id !== from && a.id !== "generic");
    // Platforms installed here come first; everything else is one step away.
    const installed = new Set(found.map((p) => p.adapter));
    const near = targets.filter((a) => installed.has(a.id));
    const rest = targets.filter((a) => !installed.has(a.id));
    let where = await choose(rl, "Move it where?", [
      ...near.map((a) => ({ label: `${label(a)}  ${dim("found here")}`, value: a.id as string })),
      { label: `Save as a .nomad file ${dim("(to share or keep)")}`, value: "@file" },
      { label: `Another platform ${dim(`(${rest.length} more)`)}`, value: "@more" }
    ]);
    if (where === "@more") where = await choose(rl, "Which platform?", rest.map((a) => ({ label: label(a), value: a.id as string })));
    if (where === "@file") {
      const name = (await nomad.loadSource(source).catch(() => null))?.doc.name ?? "agent";
      const def = `./${name.replace(/[^A-Za-z0-9._-]+/g, "-")}.nomad`;
      const a = (await rl.question(`Save to ${dim(`[${def}]`)}: `)).trim();
      dest = { kind: "file", path: resolve(a || def) };
    } else {
      const info = getAdapter(where).info;
      const def = info.defaultLocations[0] ?? displayPath(process.cwd());
      const a = (await rl.question(`${info.displayName} folder ${dim(`[${def}]`)}: `)).trim();
      dest = { kind: "platform", adapter: where, root: resolveRoot(a || def) };
    }
  } finally {
    rl.close();
  }
  process.stderr.write("\n");
  return moveTo(nomad, source, dest, {});
}

program.action(() => {
  if (!process.stdin.isTTY || !process.stderr.isTTY || out().json) {
    program.outputHelp();
    return;
  }
  return run(guided);
});

program.parseAsync(process.argv);
