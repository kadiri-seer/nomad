/**
 * nomad deploy: turn an agent you already have (Claude Code, OpenClaw, Codex, Hermes and the rest) into an agent
 * that runs on Nomad around the clock, with its own wallet and limits.
 *
 * The command only prepares a draft: the agent's name, its instructions (persona, instructions and what its skills
 * are for) and which of its tools Nomad's cloud agents can also use. Secrets were already removed when the agent was
 * read, and are removed again here; keys, sign-ins and local files never leave this computer. The draft is kept on
 * Nomad for 24 hours under an unguessable link, and the person creates the agent from it on their account page,
 * where they choose its type and limits, sign and pay. Nothing is created or paid from here.
 */
import { redactText } from "@nomad/security";
import { knownServerId } from "@nomad/adapters";
import type { AgentDocument } from "@nomad/schema";

export const DEFAULT_SITE = "https://www.thenomad.website";
/** As many characters of instructions as an agent on Nomad keeps. */
export const MAX_DEPLOY_INSTRUCTIONS = 4000;

/** Services agents on Nomad can use in the cloud, by Nomad's id for the server. */
const CLOUD_TOOLS: Record<string, string> = {
  hey: "HEY Research",
  zolva: "Zolva",
  qhooks: "QHooks",
  stoa: "Stoa",
  rushr: "Rushr",
  hedgehood: "Hedgehood",
  priors: "Priors",
  oddsengine: "OddsEngine"
};
/** Servers that trade or move money: an agent that uses them is set up as one with its own instructions, which can trade. */
const TRADING = new Set(["rushr", "qhooks", "stoa", "oak", "zolva", "hedgehood", "robinhood-trading", "virtuals", "upoch"]);

export type DeployDraft = {
  v: 1;
  name: string;
  /** "blank" (its own instructions, may trade within its limits) or "researcher" (reports only, never trades). */
  template: "blank" | "researcher";
  instructions: string;
  /** True when the instructions were longer than an agent on Nomad keeps and were shortened. */
  trimmed: boolean;
  /** The app it came from, as people know it. */
  from: string;
  /** Its tools that agents on Nomad can also use. */
  cloud: string[];
  /** Its tools that stay on this computer (local programs, keys, other services). */
  local: string[];
};

/** Shortens text to at most `max` characters at the end of a paragraph or sentence where it can. */
function shorten(text: string, max: number): { text: string; trimmed: boolean } {
  if (text.length <= max) return { text, trimmed: false };
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". ") + 1);
  return { text: (at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd(), trimmed: true };
}

/** The draft for an agent: what it is told, what it can use in the cloud, and what stays here. */
export function deployDraft(doc: AgentDocument, from: string): DeployDraft {
  const parts: string[] = [];
  const persona = doc.identity?.persona?.trim();
  if (persona) parts.push(persona);
  for (const i of doc.instructions ?? []) {
    const body = i.content.trim();
    if (body) parts.push(i.title ? `## ${i.title}\n\n${body}` : body);
  }
  const skills = (doc.skills ?? []).filter((s) => s.name);
  if (skills.length) parts.push(`## Skills it had in ${from}\n\n${skills.map((s) => `- ${s.name}${s.description ? `: ${s.description.replace(/\s+/g, " ").slice(0, 200)}` : ""}`).join("\n")}`);
  const joined = redactText(parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim()).text;
  const { text, trimmed } = shorten(joined, MAX_DEPLOY_INSTRUCTIONS);

  const cloud = new Set<string>();
  const local = new Set<string>();
  let trades = false;
  for (const t of doc.tools ?? []) {
    const id = knownServerId(t);
    if (id && TRADING.has(id)) trades = true;
    if (id && CLOUD_TOOLS[id]) cloud.add(CLOUD_TOOLS[id]);
    else local.add(t.name);
  }
  return {
    v: 1,
    name: (doc.identity?.name || doc.name).trim().slice(0, 64) || "My agent",
    template: trades ? "blank" : "researcher",
    instructions: text,
    trimmed,
    from,
    cloud: [...cloud].sort(),
    local: [...local].sort()
  };
}

/** Sends the draft to Nomad and returns the link that opens it on the account page. */
export async function uploadDraft(draft: DeployDraft, site = DEFAULT_SITE, fetchImpl: typeof fetch = fetch): Promise<{ id: string; url: string }> {
  const r = await fetchImpl(`${site}/api/agents/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft), signal: AbortSignal.timeout(20_000) });
  const j = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!r.ok || typeof j.id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(j.id)) throw new Error(j.error ?? `Nomad did not take the draft (${r.status}).`);
  return { id: j.id, url: `${site}/account?deploy=${j.id}` };
}
