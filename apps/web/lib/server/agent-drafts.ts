/**
 * Drafts from `nomad deploy`: an agent someone has elsewhere, prepared on their computer (secrets already removed),
 * kept for 24 hours under an unguessable id until they create it on their account page. A draft is only words and
 * a list of tool names: it creates, pays and signs nothing.
 */
import { randomBytes } from "node:crypto";
import { scanText } from "@nomad/security";
import type { RedisLike } from "../redis";

export type AgentDraft = { v: 1; name: string; template: "blank" | "researcher"; instructions: string; trimmed: boolean; from: string; cloud: string[]; local: string[]; at: number };

export const DRAFT_TTL_SECONDS = 24 * 3600;
const KEY = (id: string) => `nomad:agent-draft:${id}`;
const plain = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const names = (v: unknown) => (Array.isArray(v) ? v.map((x) => plain(x, 64)).filter(Boolean).slice(0, 40) : []);

export class DraftError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Checks a draft from the command line: its shape, no secrets, and no planted orders. */
export async function checkDraft(b: Record<string, unknown>, venin: (path: string, text: string) => Promise<number>, now = Date.now()): Promise<AgentDraft> {
  if (b.v !== 1) throw new DraftError(400, "Update Nomad (nomad update) and try again.");
  const name = plain(b.name, 64);
  if (!name) throw new DraftError(400, "The agent has no name.");
  const instructions = typeof b.instructions === "string" ? b.instructions.replace(/\r\n/g, "\n").trim() : "";
  if (instructions.length > 4000) throw new DraftError(400, "The instructions are longer than 4,000 characters.");
  if (scanText(`${name}\n${instructions}`, "draft.md").length) throw new DraftError(400, "The draft contains what looks like a key or secret, so it was not kept. Remove it from the agent and try again.");
  if (instructions && (await venin("deploy/instructions.md", instructions).catch(() => 0)) > 0) throw new DraftError(400, "Venin found what look like planted orders in this agent's instructions, so it was not kept.");
  return {
    v: 1,
    name,
    template: b.template === "blank" ? "blank" : "researcher",
    instructions,
    trimmed: b.trimmed === true,
    from: plain(b.from, 40) || "your agent",
    cloud: names(b.cloud),
    local: names(b.local),
    at: now
  };
}

export function draftStore(redis: RedisLike) {
  return {
    async put(d: AgentDraft): Promise<string> {
      const id = randomBytes(18).toString("base64url");
      await redis.cmd(["SET", KEY(id), JSON.stringify(d), "EX", DRAFT_TTL_SECONDS]);
      return id;
    },
    async get(id: string): Promise<AgentDraft | null> {
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
      const raw = await redis.cmd(["GET", KEY(id)]);
      return typeof raw === "string" ? (JSON.parse(raw) as AgentDraft) : null;
    }
  };
}
