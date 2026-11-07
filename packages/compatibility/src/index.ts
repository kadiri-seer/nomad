import type { AgentDocument, ComponentCategory } from "@nomad/schema";
import { COMPONENT_CATEGORIES } from "@nomad/schema";
import { componentCount, type AdapterInfo, type CategorySupport } from "@nomad/core";

export type CompatStatus = "full" | "convert" | "manual" | "unsupported" | "not-applicable";

export const STATUS_LABELS: Record<CompatStatus, string> = {
  full: "Fully supported",
  convert: "Supported with conversion",
  manual: "Requires manual setup",
  unsupported: "Unsupported",
  "not-applicable": "Not applicable"
};

export const CATEGORY_LABELS: Record<ComponentCategory, string> = {
  identity: "Identity",
  instructions: "Instructions",
  memory: "Memory",
  skills: "Skills",
  tools: "Tools",
  integrations: "Integrations",
  models: "Models",
  permissions: "Permissions",
  workflows: "Workflows",
  knowledge: "Knowledge files",
  project: "Project configuration"
};

/** How much each category matters when computing the overall score. */
export const CATEGORY_WEIGHTS: Record<ComponentCategory, number> = {
  identity: 2,
  instructions: 3,
  memory: 3,
  skills: 2,
  tools: 2,
  integrations: 1,
  models: 1,
  permissions: 2,
  workflows: 1,
  knowledge: 1,
  project: 1
};

const STATUS_FACTOR: Record<Exclude<CompatStatus, "not-applicable">, number> = {
  full: 1,
  convert: 0.75,
  manual: 0.4,
  unsupported: 0
};

const ORDER: CategorySupport[] = ["full", "convert", "manual", "unsupported"];

function worst(a: CategorySupport, b: CategorySupport): CategorySupport {
  return ORDER[Math.max(ORDER.indexOf(a), ORDER.indexOf(b))];
}

export interface CategoryCompatibility {
  category: ComponentCategory;
  label: string;
  status: CompatStatus;
  statusLabel: string;
  items: number;
  sourceRead: CategorySupport | null;
  destinationWrite: CategorySupport;
  explanation: string;
  /** True when this gap deserves attention regardless of the score. */
  attention: boolean;
}

export interface CompatibilityReport {
  source: string | null;
  destination: string;
  categories: CategoryCompatibility[];
  score: number | null;
  scoreExplanation: string;
  attention: string[];
}

const IMPORTANT: ComponentCategory[] = ["instructions", "memory", "skills", "tools", "permissions", "workflows"];

function explain(category: ComponentCategory, status: CompatStatus, dest: AdapterInfo, items: number, doc: AgentDocument | null): string {
  const note = dest.capabilities[category].notes;
  const base = (() => {
    switch (status) {
      case "not-applicable":
        return "The agent has nothing in this category.";
      case "full":
        return `${dest.displayName} stores this natively.`;
      case "convert":
        return `${dest.displayName} stores this in a different structure, so Nomad converts it.`;
      case "manual":
        return `Nomad keeps the definition, but you finish setup in ${dest.displayName}.`;
      case "unsupported":
        return `${dest.displayName} has no equivalent. The data is kept in the package and listed in the report.`;
    }
  })();
  let extra = "";
  if (category === "permissions" && doc && status !== "full" && status !== "not-applicable") {
    const restrictive = doc.permissions.rules.filter((r) => r.effect !== "allow").length;
    if (restrictive) extra = ` ${restrictive} restriction(s) may not be enforced by the destination.`;
  }
  if (category === "workflows" && items) extra += " Imported routines always start disabled.";
  return [base, note, extra.trim()].filter(Boolean).join(" ");
}

/**
 * Compare what an agent contains against what the source and destination support.
 * When `source` is null the agent comes from a package, which carries everything.
 */
export function analyzeCompatibility(doc: AgentDocument | null, source: AdapterInfo | null, destination: AdapterInfo): CompatibilityReport {
  const categories: CategoryCompatibility[] = [];
  let weighted = 0;
  let weightTotal = 0;
  const attention: string[] = [];
  for (const category of COMPONENT_CATEGORIES) {
    const items = doc ? componentCount(doc, category) : 1;
    const sourceRead = source ? source.capabilities[category].read : null;
    const destinationWrite = destination.capabilities[category].write;
    let status: CompatStatus;
    if (items === 0) status = "not-applicable";
    else status = sourceRead ? worst(sourceRead, destinationWrite) : destinationWrite;
    if (status !== "not-applicable") {
      weighted += CATEGORY_WEIGHTS[category] * STATUS_FACTOR[status];
      weightTotal += CATEGORY_WEIGHTS[category];
    }
    const isAttention = items > 0 && (status === "unsupported" || (status === "manual" && IMPORTANT.includes(category)));
    if (isAttention) {
      attention.push(
        status === "unsupported"
          ? `${CATEGORY_LABELS[category]}: ${destination.displayName} has no place for ${items === 1 ? "1 item" : `${items} items`}, so ${items === 1 ? "it is" : "they are"} not moved. Nomad keeps a copy and gives you steps to set ${items === 1 ? "it" : "them"} up another way.`
          : `${CATEGORY_LABELS[category]}: you finish setting up ${items === 1 ? "1 item" : `${items} items`} in ${destination.displayName} yourself. Nomad lists the steps.`
      );
    }
    categories.push({
      category,
      label: CATEGORY_LABELS[category],
      status,
      statusLabel: STATUS_LABELS[status],
      items,
      sourceRead,
      destinationWrite,
      explanation: explain(category, status, destination, items, doc),
      attention: isAttention
    });
  }
  const score = weightTotal ? Math.round((weighted / weightTotal) * 100) : null;
  const scoreExplanation =
    "Each category the agent uses counts with a weight (instructions and memory 3, identity, skills, tools and permissions 2, the rest 1). " +
    "Fully supported counts 100%, converted 75%, manual setup 40%, unsupported 0%. The score is the weighted average. " +
    "Categories the agent does not use are left out. Items flagged for attention matter even when the score is high.";
  return { source: source?.id ?? null, destination: destination.id, categories, score, scoreExplanation, attention };
}

/** Platform level matrix (no agent): what each platform can read and write per category. */
export function platformMatrix(adapters: AdapterInfo[]) {
  return adapters.map((a) => ({
    id: a.id,
    name: a.displayName,
    support: a.support,
    category: a.category,
    capabilities: COMPONENT_CATEGORIES.map((c) => ({ category: c, ...a.capabilities[c] }))
  }));
}
