import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { NomadError } from "@nomad/core";
import { displayPath } from "@nomad/core/node";
import {
  applyConnect,
  applySendBack,
  borrowAgent,
  connectStatus,
  gatherAgents,
  homeAgents,
  nomadLaunch,
  notGathered,
  parseSource,
  planConnect,
  planDisconnect,
  previewSendBack,
  type ConnectPlan,
  type Nomad,
  type SendBackPreview
} from "@nomad/migration";
import { CMD, bold, dim, green, print, red, table, yellow, type Output } from "./format";

/** What the home and connect commands need from the main program, passed in so this file does not run it. */
export interface CliKit {
  run: (fn: (nomad: Nomad) => Promise<number | void>) => Promise<void>;
  out: () => Output;
  confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
  approvalOptions: (cmd: Command) => Command;
  /** Preview and apply moving a home agent to an app (nomad move). */
  bring: (nomad: Nomad, agentId: string, to: string, o: Record<string, unknown>) => Promise<number>;
  /** The --home directory, when given. */
  home: () => string | undefined;
  /** The installer's root folder, when Nomad was installed with it. */
  installRoot: () => string | null;
  EXIT: { ok: number; error: number; usage: number; approval: number };
}

const collect = (v: string, prev: string[] = []) => [...prev, v];
const list = (v?: string) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function when(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

export function sendBackText(p: SendBackPreview): string[] {
  const mark: Record<string, string> = { add: green("add"), update: yellow("update"), conflict: red("both changed"), skip: dim("skip") };
  const lines = [bold(`Send back to ${p.agent.name}`) + dim(`  from ${p.from}, home version ${p.agent.version}${p.baseVersion ? `, made from version ${p.baseVersion}` : ""}`), ""];
  const shown = p.changes.filter((c) => c.action !== "skip");
  if (shown.length) {
    for (const c of shown) {
      lines.push(`  ${mark[c.action]}  ${c.category}: ${c.label}${c.resolution ? dim(c.resolution === "home" ? "  (keeping the home's version)" : "  (using the new version)") : ""}`);
      if (c.action === "conflict") lines.push(dim(`        home: ${c.home?.replace(/\n/g, " ").slice(0, 160)}`), dim(`        new:  ${c.incoming.replace(/\n/g, " ").slice(0, 160)}`), dim(`        key:  ${c.key}`));
      else if (c.action === "update") lines.push(dim(`        now:  ${c.incoming.replace(/\n/g, " ").slice(0, 160)}`));
    }
  }
  const skipped = p.changes.filter((c) => c.action === "skip");
  if (skipped.length) lines.push(dim(`  ${skipped.length} entr${skipped.length === 1 ? "y" : "ies"} skipped (already in the home, or the home has a newer version).`));
  if (p.notes.length) lines.push("", ...p.notes.map((n) => yellow("! ") + n));
  lines.push("", `${p.summary.add} to add, ${p.summary.update} to update${p.summary.unresolved ? `, ${red(`${p.summary.unresolved} to choose`)}` : ""}.`);
  if (p.summary.unresolved) lines.push(dim(`Choose with --keep-home <key> or --use-new <key> for each entry changed in both places.`));
  return lines;
}

export function connectText(p: ConnectPlan): string[] {
  const lines: string[] = [];
  if (!p.targets.length) return ["No apps Nomad can connect to were found on this computer.", dim(`Name one with --app (claude-code, codex, openclaw, hermes, gemini-cli, cursor, claude-desktop).`)];
  if (p.mode === "connect") lines.push(bold("Connect Nomad") + dim(`  apps will start: ${[p.launch.command, ...p.launch.args, "mcp"].join(" ")}${p.allowWrites ? " (assistants can apply approved changes)" : " (read only)"}`), "");
  else lines.push(bold("Take Nomad out of your apps"), "");
  const verb: Record<string, string> = { add: green("add"), update: yellow("update"), unchanged: dim("already there"), remove: yellow("remove"), absent: dim("not connected"), blocked: red("cannot change"), manual: yellow("one command for you to run") };
  for (const t of p.targets) {
    const skill = t.skill === "none" ? "" : t.skill === "add" ? ", with the nomad skill" : t.skill === "update" ? ", updating the nomad skill" : t.skill === "remove" ? ", and the nomad skill" : t.skill === "kept" ? dim(", skill kept") : "";
    lines.push(`  ${t.displayName.padEnd(20)} ${verb[t.server]}${skill}  ${dim(t.config)}${t.detected ? "" : dim("  (not found here)")}`);
    if (t.error) lines.push(red(`      ${t.error}`));
    for (const n of t.notes) lines.push(yellow(`      ! ${n}`));
  }
  lines.push("", p.changes ? `${p.changes} file(s) will change. Each is backed up first.` : "Nothing to change.");
  return lines;
}

export function registerHomeCommands(program: Command, kit: CliKit) {
  const { run, out, confirm, EXIT } = kit;

  const home = program.command("home").description("your Nomad home: every agent in one place, to use from any app");

  home
    .command("list", { isDefault: true })
    .description("show the agents in your home and where each lives")
    .option("--search <words>", "only agents matching these words")
    .action((o) =>
      run(async (nomad) => {
        const agents = homeAgents(nomad, { search: o.search });
        const extra = await notGathered(nomad);
        print(
          out(),
          () => {
            const lines: string[] = [];
            if (!agents.length) lines.push(o.search ? `No agents match "${o.search}".` : "Your home is empty.");
            else
              lines.push(
                table(
                  agents.map((a) => [
                    a.name + (a.fromOthers ? dim(" (from others)") : ""),
                    `v${a.version}`,
                    a.copies.length ? a.copies.map((c) => (c.behind ? yellow(`${c.app} (behind)`) : c.app)).join(", ") : dim("home only"),
                    String(a.tools.length),
                    String(a.skills.length),
                    String(a.memoryEntries),
                    when(a.updatedAt)
                  ]),
                  ["Agent", "Version", "Lives in", "Tools", "Skills", "Memory", "Updated"]
                )
              );
            if (extra.length) lines.push("", `${extra.length} agent(s) in your apps are not in the home yet: ${extra.map((x) => `${x.name} (${x.app})`).join(", ")}.`, dim(`Add them with: ${CMD} home gather`));
            if (agents.length) lines.push("", dim(`Use one in any chat: ${CMD} home borrow <agent>    Install one in an app: ${CMD} home bring <agent> <app>`));
            return lines;
          },
          { agents, notInHomeYet: extra }
        );
      })
    );

  home
    .command("gather")
    .description("add the agents found in your apps to the home (apps are only read)")
    .action(() =>
      run(async (nomad) => {
        const r = await gatherAgents(nomad);
        print(
          out(),
          () => [
            ...(r.gathered.length ? r.gathered.map((g) => `${g.added ? green("added") : dim("updated")}  ${g.name}  ${dim(`${g.app}, ${g.display}`)}${g.secretsRedacted ? yellow(`  ${g.secretsRedacted} secret(s) redacted`) : ""}`) : ["No agents were found at the usual places."]),
            ...r.failed.map((f) => red("failed ") + ` ${f.app} ${f.display}#${f.nativeId}: ${f.error}`)
          ],
          r
        );
        return r.failed.length && !r.gathered.length ? EXIT.error : EXIT.ok;
      })
    );

  home
    .command("borrow <agent>")
    .description("print an agent's persona, rules and memory to paste into any chat (writes nothing)")
    .option("--version <n>", "an earlier version")
    .option("--skills <names>", 'include the full steps of these skills (comma separated, or "all")')
    .option("--memory-search <words>", "only memory entries containing these words")
    .option("--max-chars <n>", "longest text to print", "40000")
    .option("-o, --out <file>", "write the text to a file instead")
    .action((agent, o) =>
      run(async (nomad) => {
        const r = await borrowAgent(nomad, agent, { version: o.version ? Number(o.version) : undefined, skills: list(o.skills), memorySearch: o.memorySearch, maxChars: Number(o.maxChars) });
        if (o.out) {
          writeFileSync(resolve(o.out), r.text, { mode: 0o600 });
          print(out(), () => `${green("Wrote")} ${r.agent.name} v${r.agent.version} to ${displayPath(resolve(o.out))}${r.truncated ? yellow(" (shortened; raise --max-chars for more)") : ""}`, { ...r, text: undefined, path: resolve(o.out) });
          return;
        }
        if (out().json) print(out(), () => "", r);
        else process.stdout.write(r.text);
      })
    );

  kit.approvalOptions(
    home
      .command("bring <agent> <app>")
      .description("install an agent from the home in an app, with a preview first (same as nomad move)")
      .option("--components <list>", "only these components")
  ).action((agent, app, o) =>
    run(async (nomad) => {
      const a = nomad.store.resolveAgent(agent);
      if (!a) throw new NomadError(`No agent "${agent}" in your Nomad home.`, "not-found", `List the home with: ${CMD} home`);
      return kit.bring(nomad, a.id, app, o);
    })
  );

  home
    .command("send-back <agent>")
    .description("save what an agent learned in an app, or new notes, to the home as a new version")
    .option("--from <location>", "the agent's copy in an app, e.g. openclaw or claude-code:~/project")
    .option("--note <text>", "a memory entry to add (repeat for more)", collect)
    .option("--rule <text>", "a rule to add (repeat for more)", collect)
    .option("--notes-file <file>", "add each paragraph of a text file as a memory entry")
    .option("--include <list>", "with --from: also send back new or changed skills,tools")
    .option("--base-version <n>", "the home version the changes were made from")
    .option("--keep-home <key>", "for an entry changed in both places, keep the home's version (repeat)", collect)
    .option("--use-new <key>", "for an entry changed in both places, use the new version (repeat)", collect)
    .option("--dry-run", "only show the preview")
    .option("-y, --yes", "apply without asking")
    .action((agent, o) =>
      run(async (nomad) => {
        let from: { adapter: string; root: string; nativeId: string } | undefined;
        if (o.from) {
          const spec = await parseSource(nomad, o.from);
          if (spec.kind !== "location") throw new NomadError("--from must be an app or an app folder, such as openclaw or claude-code:~/project.", "usage");
          from = spec;
        }
        const notes: string[] = [...(o.note ?? [])];
        if (o.notesFile) notes.push(...readFileSync(resolve(o.notesFile), "utf8").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean));
        const include = list(o.include);
        for (const i of include) if (i !== "skills" && i !== "tools") throw new NomadError(`--include takes skills and tools, not "${i}".`, "usage");
        const prefer: Record<string, "home" | "incoming"> = {};
        for (const k of o.keepHome ?? []) prefer[k] = "home";
        for (const k of o.useNew ?? []) prefer[k] = "incoming";
        const p = await previewSendBack(nomad, {
          agent,
          from,
          memory: notes.map((content) => ({ content })),
          instructions: (o.rule ?? []).map((content: string) => ({ content })),
          include: include as Array<"skills" | "tools">,
          baseVersion: o.baseVersion ? Number(o.baseVersion) : undefined,
          prefer,
          app: from ? undefined : "the command line"
        });
        const writes = p.summary.add + p.summary.update;
        if (o.dryRun || !writes || p.summary.unresolved) {
          print(out(), () => sendBackText(p), p);
          return p.summary.unresolved && !o.dryRun ? EXIT.approval : EXIT.ok;
        }
        if (!out().json) print(out(), () => sendBackText(p), null);
        if (!o.yes) {
          if (!process.stdin.isTTY) throw new NomadError("Not running interactively.", "approval-required", "Add --yes to apply without a prompt, or --dry-run to preview.");
          if (!(await confirm(bold("\nSave this to the home?")))) {
            process.stderr.write("Nothing was changed.\n");
            return EXIT.approval;
          }
        }
        const r = applySendBack(nomad, p.id, p.token);
        print(
          out(),
          () => [
            "",
            green("Saved.") + ` ${r.agent.name} is now version ${r.version} in your home (${r.added} added, ${r.updated} updated).`,
            ...(r.behind.length ? [dim(`Behind the home now: ${r.behind.map((c) => `${c.app} (${c.display})`).join(", ")}. Update them with: ${CMD} home bring ${r.agent.name} <app>`)] : [])
          ],
          { preview: p, receipt: r }
        );
      })
    );

  const connect = program
    .command("connect")
    .description("add Nomad to your apps (Claude Code, Codex, OpenClaw, Hermes, Gemini CLI, Cursor, Claude desktop app), with a preview first")
    .option("--app <list>", "only these apps (comma separated); named apps are connected even if not found")
    .option("--allow-writes", "let assistants apply moves and send backs after you approve each preview")
    .option("--no-skill", "do not add the nomad skill")
    .option("--remove", "take Nomad out of your apps again")
    .option("--status", "show which apps have Nomad")
    .option("--dry-run", "only show the preview")
    .option("-y, --yes", "apply without asking");
  connect.action((o) =>
    run(async (nomad) => {
      if (o.status) {
        const s = await connectStatus();
        const errors = s.some((x) => x.error);
        print(out(), () => table(s.map((x) => [x.displayName, x.connected ? green("connected") + (x.writes ? "" : dim(" (read only)")) : x.detected ? "not connected" : dim("not found"), dim(x.config), ...(errors ? [x.error ? red(x.error) : ""] : [])]), ["App", "Nomad", "Settings file", ...(errors ? ["Problem"] : [])]), s);
        return;
      }
      const apps = list(o.app);
      const p = o.remove ? await planDisconnect(nomad, { apps, skill: o.skill }) : await planConnect(nomad, { launch: nomadLaunch({ installRoot: kit.installRoot() }), apps, allowWrites: !!o.allowWrites, home: kit.home(), skill: o.skill });
      const blocked = p.targets.some((t) => t.server === "blocked");
      if (o.dryRun || !p.changes) {
        print(out(), () => connectText(p), p);
        return blocked ? EXIT.error : EXIT.ok;
      }
      if (!out().json) print(out(), () => connectText(p), null);
      if (!o.yes) {
        if (!process.stdin.isTTY) throw new NomadError("Not running interactively.", "approval-required", "Add --yes to apply without a prompt, or --dry-run to preview.");
        if (!(await confirm(bold("\nGo ahead?"), true))) {
          process.stderr.write("Nothing was changed.\n");
          return EXIT.approval;
        }
      }
      const r = await applyConnect(nomad, p.id);
      print(
        out(),
        () => [
          "",
          ...r.targets.flatMap((t) => [`${t.ok ? green("ok") : red("failed")}  ${t.displayName}: ${t.detail}`, ...(t.ok && p.mode === "connect" && t.detail !== "Already connected." ? [dim(`    ${t.manual ? `Then: ${t.restart}` : t.restart}`)] : [])]),
          ...(r.backupId ? ["", dim(`Changed your mind? ${CMD} restore ${r.backupId}${p.mode === "connect" ? `  or  ${CMD} connect --remove` : ""}`)] : []),
          ...(p.mode === "connect" ? ["", `Then ask in any of them: ${bold('"Nomad, show my agents"')}.`] : [])
        ],
        { plan: p, receipt: r }
      );
      return r.targets.every((t) => t.ok) ? EXIT.ok : EXIT.error;
    })
  );
}
