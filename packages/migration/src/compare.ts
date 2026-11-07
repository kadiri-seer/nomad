import { createTwoFilesPatch } from "diff";
import type { AgentDocument, ComponentCategory } from "@nomad/schema";
import { canonicalJson } from "@nomad/core";

export interface ItemChange {
  category: ComponentCategory;
  item: string;
  change: "added" | "removed" | "changed";
  diff?: string;
}

export interface Comparison {
  left: string;
  right: string;
  identical: boolean;
  changes: ItemChange[];
  summary: Record<ComponentCategory, { added: number; removed: number; changed: number }>;
}

function textDiff(name: string, a: string, b: string): string {
  return createTwoFilesPatch(name, name, a, b, "left", "right", { context: 2 }).split("\n").slice(4).slice(0, 120).join("\n");
}

function compareList<T>(category: ComponentCategory, a: T[], b: T[], key: (x: T) => string, text: (x: T) => string, out: ItemChange[]) {
  const ma = new Map(a.map((x) => [key(x), x]));
  const mb = new Map(b.map((x) => [key(x), x]));
  for (const [k, x] of ma) {
    const y = mb.get(k);
    if (!y) out.push({ category, item: k, change: "removed" });
    else if (canonicalJson(x) !== canonicalJson(y)) {
      const ta = text(x);
      const tb = text(y);
      out.push({ category, item: k, change: "changed", diff: ta !== tb ? textDiff(k, ta, tb) : "(metadata changed)" });
    }
  }
  for (const [k] of mb) if (!ma.has(k)) out.push({ category, item: k, change: "added" });
}

/** Compare two agent documents (two versions, or the same agent on two platforms). */
export function compareDocuments(a: AgentDocument, b: AgentDocument, labels: { left?: string; right?: string } = {}): Comparison {
  const changes: ItemChange[] = [];
  const idA = { ...a.identity };
  const idB = { ...b.identity };
  if (canonicalJson(idA) !== canonicalJson(idB)) {
    changes.push({ category: "identity", item: "identity", change: "changed", diff: textDiff("identity", `${idA.name}\n${idA.description ?? ""}\n${idA.persona ?? ""}`, `${idB.name}\n${idB.description ?? ""}\n${idB.persona ?? ""}`) });
  }
  compareList("instructions", a.instructions, b.instructions, (i) => i.id, (i) => i.content, changes);
  // Memory: compare by content so the same memory under different ids matches.
  compareList("memory", a.memory, b.memory, (m) => m.content.trim().replace(/^[-*+]\s+/, "").slice(0, 80), (m) => m.content, changes);
  compareList("skills", a.skills, b.skills, (s) => s.name, (s) => `${s.description}\n\n${s.instructions}`, changes);
  compareList("tools", a.tools, b.tools, (t) => t.name, (t) => JSON.stringify(t.mcp ?? {}, null, 2), changes);
  compareList("integrations", a.integrations, b.integrations, (t) => t.name, (t) => JSON.stringify(t.config, null, 2), changes);
  compareList("workflows", a.workflows, b.workflows, (w) => w.name, (w) => JSON.stringify({ trigger: w.trigger, actions: w.actions }, null, 2), changes);
  compareList("knowledge", [...a.knowledge.map((k) => k.path), ...a.files.map((f) => f.path)], [...b.knowledge.map((k) => k.path), ...b.files.map((f) => f.path)], (x) => x, (x) => x, changes);
  if (canonicalJson(a.models) !== canonicalJson(b.models)) changes.push({ category: "models", item: "models", change: "changed", diff: textDiff("models", JSON.stringify(a.models, null, 2), JSON.stringify(b.models, null, 2)) });
  if (canonicalJson(a.permissions) !== canonicalJson(b.permissions)) changes.push({ category: "permissions", item: "policy", change: "changed", diff: textDiff("permissions", JSON.stringify(a.permissions, null, 2), JSON.stringify(b.permissions, null, 2)) });
  const summary = {} as Comparison["summary"];
  for (const c of ["identity", "instructions", "memory", "skills", "tools", "integrations", "models", "permissions", "workflows", "knowledge", "project"] as ComponentCategory[]) {
    const list = changes.filter((x) => x.category === c);
    summary[c] = { added: list.filter((x) => x.change === "added").length, removed: list.filter((x) => x.change === "removed").length, changed: list.filter((x) => x.change === "changed").length };
  }
  return { left: labels.left ?? `${a.name}`, right: labels.right ?? `${b.name}`, identical: changes.length === 0, changes, summary };
}
