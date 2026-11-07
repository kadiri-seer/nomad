import type { MigrationPlan, MigrationReceipt, Comparison, RestorePreview } from "@nomad/migration";
import type { CompatibilityReport } from "@nomad/compatibility";
import type { AgentDocument } from "@nomad/schema";

/** The name of the package on npm. */
export const NPM_NAME = "thenomad";
/** How to run Nomad again in hints: "npx thenomad" when started through npx, otherwise "nomad". */
export const CMD = process.env.npm_command === "exec" ? `npx ${NPM_NAME}` : "nomad";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = c("1");
export const dim = c("2");
export const red = c("31");
export const green = c("32");
export const yellow = c("33");
export const blue = c("34");

export interface Output {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
}

export function print(out: Output, human: () => string | string[], data: unknown) {
  if (out.json) {
    process.stdout.write(JSON.stringify(data, (_k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v), 2) + "\n");
    return;
  }
  if (out.quiet) return;
  const h = human();
  process.stdout.write((Array.isArray(h) ? h.join("\n") : h) + "\n");
}

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const widths = all[0]?.map((_, i) => Math.max(...all.map((r) => strip(r[i] ?? "").length))) ?? [];
  const line = (r: string[]) => r.map((cell, i) => cell + " ".repeat(Math.max(0, widths[i] - strip(cell).length))).join("  ").trimEnd();
  const out = all.map(line);
  if (header) out.splice(1, 0, widths.map((w) => "-".repeat(w)).join("  "));
  return out.join("\n");
}

const STATUS_COLOR: Record<string, (s: string) => string> = { full: green, convert: blue, manual: yellow, unsupported: red, "not-applicable": dim };

export function compatibilityText(r: CompatibilityReport): string[] {
  const lines = [bold("Compatibility") + (r.score !== null ? `  ${r.score}/100` : "")];
  lines.push(
    table(
      r.categories.filter((x) => x.status !== "not-applicable").map((x) => [x.label, STATUS_COLOR[x.status](x.statusLabel), String(x.items), dim(x.explanation)]),
      ["Category", "Status", "Items", "Why"]
    )
  );
  if (r.attention.length) lines.push("", yellow("Needs attention"), ...r.attention.map((a) => `  ! ${a}`));
  return lines;
}

const ACTION: Record<string, string> = { create: green("create"), update: yellow("update"), unchanged: dim("same"), "keep-existing": blue("keep") };

export function planText(p: MigrationPlan, verbose: boolean): string[] {
  const lines: string[] = [];
  lines.push(bold(`Migration preview  ${p.id}`));
  lines.push(`Agent        ${p.agent.name} (${p.agent.id})`);
  lines.push(`From         ${p.source.label}`);
  lines.push(`To           ${p.destination.displayName} at ${p.destination.root} [${p.destination.support}]${p.destination.nativeId !== "main" ? ` as ${p.destination.nativeId}` : ""}`);
  lines.push(`Mode         ${p.mode}`);
  lines.push("");
  lines.push(...compatibilityText(p.compatibility));
  lines.push("", bold("File changes") + `  ${p.summary.create} new, ${p.summary.update} modified, ${p.summary.kept} kept, ${p.summary.unchanged} unchanged`);
  lines.push(table(p.operations.map((o) => [ACTION[o.action] ?? o.action, o.path, dim(o.description)])));
  if (p.conflicts.length) lines.push("", yellow("Conflicts"), ...p.conflicts.map((x) => `  ${x.path}: ${x.detail}`));
  if (p.conversions.length) lines.push("", bold("Converted"), ...p.conversions.map((x) => `  ${x.category}: ${x.item} (${x.from} -> ${x.to})`));
  if (p.unsupported.length) lines.push("", red("Cannot transfer"), ...p.unsupported.map((x) => `  ${x.category}: ${x.item}. ${x.reason}${x.alternative ? " " + dim(x.alternative) : ""}`));
  if (p.permissions.widened.length) lines.push("", red("Broader permissions at the destination"), ...p.permissions.widened.map((w) => `  ${w}`));
  if (p.permissions.unenforced.length) lines.push("", yellow("Restrictions the destination will not enforce"), ...p.permissions.unenforced.map((w) => `  ${w}`));
  if (p.disabledRoutines.length) lines.push("", bold("Routines imported disabled"), ...p.disabledRoutines.map((w) => `  ${w}`));
  if (p.secrets.findings || p.secrets.strippedEnv.length) lines.push("", yellow("Secrets"), `  ${p.secrets.findings} detected, ${p.secrets.redacted} redacted, ${p.secrets.strippedEnv.length} credential(s) replaced by references`);
  if (p.manualSteps.length) lines.push("", bold("After migration"), ...p.manualSteps.map((s, i) => `  ${i + 1}. ${s}`));
  const notes = p.notes.filter((n) => verbose || n.level !== "info");
  if (notes.length) lines.push("", bold("Notes"), ...notes.map((n) => `  ${n.level === "error" ? red("x") : n.level === "warning" ? yellow("!") : "-"} ${n.message}`));
  if (p.approvalsRequired.length) lines.push("", red("Approval required: ") + p.approvalsRequired.join(", "));
  if (p.blocked.length) lines.push("", red("Blocked"), ...p.blocked.map((b) => `  ${b}`));
  if (verbose) for (const o of p.operations) if (o.diff) lines.push("", dim(o.diff));
  return lines;
}

export function receiptText(r: MigrationReceipt): string[] {
  const ok = r.status === "success";
  const lines = [
    (ok ? green("Done") : red(r.status === "verification-failed" ? "Written, but verification failed" : "Failed and rolled back")) + `  ${r.operationId}`,
    `${r.agent.name} -> ${r.destination.adapter} at ${r.destination.root}`
  ];
  if (r.error) lines.push(red(r.error));
  lines.push("", bold("Verification"), ...r.verification.map((v) => `  ${v.ok ? green("ok") : red("fail")}  ${v.name}${v.detail ? dim(" " + v.detail) : ""}`));
  if (r.files.length) lines.push("", `${r.files.filter((f) => f.action === "create" || f.action === "update").length} file(s) written`);
  if (r.backupId) lines.push(`Backup ${r.backupId}. Undo with: ${CMD} restore ${r.backupId}`);
  if (r.manualSteps.length) lines.push("", bold("Next steps"), ...r.manualSteps.map((s, i) => `  ${i + 1}. ${s}`));
  if (r.disabledRoutines.length) lines.push("", `Routines imported disabled: ${r.disabledRoutines.join(", ")}`);
  return lines;
}

export function docText(doc: AgentDocument): string[] {
  const lines = [bold(doc.name) + dim(`  ${doc.id}`), doc.description ?? doc.identity.description ?? "", ""];
  lines.push(`Platform     ${doc.source.platform}${doc.source.location ? ` (${doc.source.location})` : ""}`);
  if (doc.models.preferred) lines.push(`Model        ${doc.models.preferred}`);
  if (doc.identity.persona) lines.push(`Persona      ${doc.identity.persona.split("\n")[0].slice(0, 90)}`);
  lines.push("");
  lines.push(
    table(
      [
        ["Instructions", String(doc.instructions.length), doc.instructions.map((i) => i.title ?? i.id).join(", ")],
        ["Memory", String(doc.memory.length), [...new Set(doc.memory.map((m) => m.kind))].join(", ")],
        ["Skills", String(doc.skills.length), doc.skills.map((s) => s.name).join(", ")],
        ["Tools", String(doc.tools.length), doc.tools.map((t) => t.name).join(", ")],
        ["Integrations", String(doc.integrations.length), doc.integrations.map((t) => t.name).join(", ")],
        ["Workflows", String(doc.workflows.length), doc.workflows.map((w) => `${w.name}${w.sourceEnabled ? "" : " (paused)"}`).join(", ")],
        ["Permissions", String(doc.permissions.rules.length), `mode ${doc.permissions.mode}`],
        ["Knowledge", String(doc.knowledge.length + doc.files.length), ""]
      ].map((r) => [r[0], r[1], dim(r[2].slice(0, 80))]),
      ["Component", "Items", ""]
    )
  );
  return lines;
}

export function comparisonText(c: Comparison): string[] {
  if (c.identical) return [`${c.left} and ${c.right} are identical.`];
  const lines = [bold(`${c.left}  vs  ${c.right}`), ""];
  for (const ch of c.changes) {
    lines.push(`${ch.change === "added" ? green("+") : ch.change === "removed" ? red("-") : yellow("~")} ${ch.category}: ${ch.item}`);
    if (ch.diff) lines.push(dim(ch.diff.split("\n").map((l) => "    " + l).join("\n")));
  }
  return lines;
}

export function restoreText(p: RestorePreview): string[] {
  return [bold(`Restore ${p.backupId}`) + dim(`  ${p.description}, ${p.createdAt}`), ...p.items.map((i) => `  ${i.action.padEnd(9)} ${i.path}${i.reason ? dim(" " + i.reason) : ""}`), "", `${p.changes} file(s) would change.`];
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** The short, plain-language preview shown by default. */
export function summaryText(p: MigrationPlan): string[] {
  const moving = p.compatibility.categories.filter((c) => c.items > 0 && (c.status === "full" || c.status === "convert"));
  const what = moving
    .filter((c) => ["instructions", "memory", "skills", "tools", "workflows"].includes(c.category))
    .map((c) => (c.category === "memory" ? plural(c.items, "memory", "memories") : c.category === "workflows" ? plural(c.items, "routine") : c.category === "instructions" ? plural(c.items, "instruction section") : plural(c.items, c.category.slice(0, -1))));
  const lines = [
    bold(`${p.agent.name} → ${p.destination.displayName}`) + dim(`  (${p.destination.root})`),
    `Moves ${["persona", ...what].join(", ")}.`
  ];
  if (p.conversions.length) lines.push(`Adapted: ${p.conversions.map((c) => `${c.item} ${dim("→ " + c.to)}`).join("; ")}.`);
  if (p.unsupported.length) lines.push(yellow(`Can't move: ${p.unsupported.map((u) => u.item).join(", ")}`) + dim(" (kept in the report with setup steps)"));
  if (p.disabledRoutines.length) lines.push(`Routines arrive paused: ${p.disabledRoutines.join(", ")}.`);
  if (p.secrets.findings || p.secrets.strippedEnv.length) {
    const parts = [p.secrets.findings ? `${p.secrets.findings} found in text and removed` : "", p.secrets.strippedEnv.length ? `you will reconnect ${p.secrets.strippedEnv.map((s) => s.split(":")[1]).join(", ")}` : ""].filter(Boolean);
    lines.push(`Secrets stay behind: ${parts.join("; ")}.`);
  }
  const files = [p.summary.create && `${p.summary.create} new`, p.summary.update && `${p.summary.update} updated`, p.summary.kept && `${p.summary.kept} kept as they are`].filter(Boolean).join(", ");
  lines.push(`Files: ${files || "nothing changes"}. A backup is taken first.`);
  for (const c of p.conflicts.slice(0, 3)) lines.push(dim(`  ${c.path}: ${c.detail}`));
  if (p.conflicts.length > 3) lines.push(dim(`  and ${p.conflicts.length - 3} more (use --details)`));
  if (p.blocked.length) lines.push(red(`Can't run: ${p.blocked.join(" ")}`));
  return lines;
}

/** Plain-language question for the approvals a plan needs. */
export function approvalQuestion(p: MigrationPlan): string | null {
  const parts: string[] = [];
  if (p.approvalsRequired.includes("replace")) parts.push(`it replaces content Nomad did not create`);
  if (p.approvalsRequired.includes("overwrite-modified")) parts.push(`it overwrites files you edited after Nomad wrote them`);
  if (p.approvalsRequired.includes("broader-permissions")) parts.push(`the destination would allow more than it does now (${p.permissions.widened.join("; ")})`);
  return parts.length ? `Heads up: ${parts.join(", and ")}.` : null;
}
