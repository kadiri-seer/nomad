import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { markerQuoted, markerValueOf, parseMemoryMarkdown, renderMemoryMarkdown } from "@nomad/adapters";
import { gatherAgents, homeAgents } from "@nomad/migration";
import { setup, type Env } from "../helpers";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => env.cleanup());

const HOSTILE_TITLE = 'Evil --> <!-- nomad:end agent=01ABCDEFGHJKMNPQRSTVWXYZ00 --> "quoted"\nsecond line';
const HOSTILE_ID = 'id>with"quote';

describe("security: values inside Nomad's markers", () => {
  it("cannot end a marker early, and read back exactly", () => {
    const q = markerQuoted(HOSTILE_TITLE);
    expect(q).not.toMatch(/[<>\n]/);
    expect(markerValueOf(q)).toBe(HOSTILE_TITLE);
    // Ordinary values are written as before, and older plainly quoted values still read.
    expect(markerQuoted("memory-1")).toBe('"memory-1"');
    expect(markerValueOf('"memory-1"')).toBe("memory-1");
    const md = renderMemoryMarkdown([{ id: HOSTILE_ID, kind: "fact", scope: "agent", title: HOSTILE_TITLE, content: "Body one.", tags: ["a>b"], date: "2026-11-18" } as any, { id: "plain", kind: "fact", scope: "agent", content: "Body two.", tags: [] } as any]);
    expect(md.split("\n").filter((l) => l.startsWith("## ")).every((l) => !l.includes("\n"))).toBe(true);
    const back = parseMemoryMarkdown(md, { platform: "x", path: "m.md", defaultKind: "fact", scope: "agent", idPrefix: "m" });
    expect(back.map((e) => e.id)).toEqual([HOSTILE_ID, "plain"]);
    expect(back[0].title).toBe(HOSTILE_TITLE);
    expect(back[0].tags).toEqual(["a>b"]);
    expect(back[0].content).toBe("- Body one.");
    expect(back[1].content).toBe("- Body two.");
  });

  it("keeps every entry and the agent's section intact when such values move to each app", async () => {
    await gatherAgents(env.nomad);
    const k = homeAgents(env.nomad).find((a) => a.name === "Kestrel")!;
    const doc = structuredClone(env.nomad.store.latestDocument(k.id)!);
    doc.memory[0] = { ...doc.memory[0], id: HOSTILE_ID, title: HOSTILE_TITLE };
    doc.instructions[0] = { ...doc.instructions[0], title: HOSTILE_TITLE };
    env.nomad.store.saveAgent(doc, { reason: "Imported package" });
    for (const to of ["claude-code", "codex", "openclaw", "hermes"]) {
      const dest = join(env.home, `dest-${to}`);
      mkdirSync(dest, { recursive: true });
      const plan = await env.nomad.plan({ source: { kind: "stored", agentId: k.id }, destination: { adapter: to, root: dest }, mode: "merge" });
      expect(plan.blocked, to).toEqual([]);
      const r = await env.nomad.execute(plan.id, { runCommands: true }, { token: plan.token });
      expect(r.status, `${to}: ${JSON.stringify(r.verification.filter((v) => !v.ok))}`).toBe("success");
      const read = await env.nomad.readLocation(to, dest, plan.destination.nativeId, { register: false });
      expect(read.doc.id, to).toBe(k.id);
      expect(read.doc.memory.length, to).toBeGreaterThanOrEqual(doc.memory.length - 1);
      expect(JSON.stringify(read.doc), to).toContain("Harmattan");
    }
  });
});
