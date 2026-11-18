import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applySendBack, borrowAgent, gatherAgents, homeAgents, notGathered, previewSendBack } from "@nomad/migration";
import { FAKE_OPENAI_KEY } from "../fixtures/platforms";
import { setup, treeHash, type Env } from "../helpers";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => env.cleanup());

const versions = (id: string) => env.nomad.store.listVersions(id).length;

describe("your Nomad: show and gather", () => {
  it("lists agents found in apps before they are gathered, then gathers them without touching the apps", async () => {
    expect(homeAgents(env.nomad)).toEqual([]);
    const waiting = await notGathered(env.nomad);
    expect([...new Set(waiting.map((w) => w.adapter))].sort()).toEqual(["claude-code", "codex", "hermes", "openclaw"]);
    const before = treeHash(env.home + "/.openclaw");
    const r = await gatherAgents(env.nomad);
    expect(r.failed).toEqual([]);
    expect(r.gathered.length).toBe(waiting.length);
    expect(r.gathered.every((g) => g.added)).toBe(true);
    expect(treeHash(env.home + "/.openclaw")).toBe(before);
    const home = homeAgents(env.nomad);
    expect(home.length).toBe(waiting.length);
    const k = home.find((a) => a.name === "Kestrel")!;
    expect(k.copies).toHaveLength(1);
    expect(k.copies[0].adapter).toBe("openclaw");
    expect(k.copies[0].behind).toBe(false);
    expect(k.skills).toContain("weather-brief");
    expect(await notGathered(env.nomad)).toEqual([]);
    // Gathering again adds nothing new.
    const again = await gatherAgents(env.nomad);
    expect(again.gathered.every((g) => !g.added)).toBe(true);
    expect(homeAgents(env.nomad).length).toBe(waiting.length);
  });

  it("narrows the list by search words", async () => {
    await gatherAgents(env.nomad);
    expect(homeAgents(env.nomad, { search: "weather-brief" }).map((a) => a.name)).toEqual(["Kestrel"]);
    expect(homeAgents(env.nomad, { search: "no such words here" })).toEqual([]);
  });
});

describe("your Nomad: borrow", () => {
  it("returns the persona, rules and memory as text, writes nothing and never includes secrets", async () => {
    await gatherAgents(env.nomad);
    const k = homeAgents(env.nomad).find((a) => a.name === "Kestrel")!;
    const v = versions(k.id);
    const ops = env.nomad.history().length;
    const files = treeHash(env.home + "/.openclaw");
    const r = await borrowAgent(env.nomad, "Kestrel");
    expect(r.agent.name).toBe("Kestrel");
    expect(r.text).toContain("# Borrowed agent: Kestrel");
    expect(r.text).toContain("calm and precise");
    expect(r.text).toContain("Before sending email, show me the draft.");
    expect(r.text).toContain("Harmattan");
    expect(r.text).toContain("weather-brief");
    expect(r.text).toContain("does not approve file changes");
    expect(r.text).not.toContain(FAKE_OPENAI_KEY);
    expect(r.fromOthers).toBe(false);
    // Nothing written: no version, no operation, no app file.
    expect(versions(k.id)).toBe(v);
    expect(env.nomad.history().length).toBe(ops);
    expect(treeHash(env.home + "/.openclaw")).toBe(files);
  });

  it("includes a skill's steps only when asked, filters memory, and stays under the limit", async () => {
    await gatherAgents(env.nomad);
    const plain = await borrowAgent(env.nomad, "Kestrel");
    expect(plain.text).not.toContain("Run scripts/fetch.py");
    const full = await borrowAgent(env.nomad, "Kestrel", { skills: ["weather-brief"] });
    expect(full.text).toContain("Run scripts/fetch.py");
    expect(full.counts.skillsWithInstructions).toBe(1);
    const some = await borrowAgent(env.nomad, "Kestrel", { memorySearch: "DuckDB" });
    expect(some.counts.memoryShown).toBeGreaterThan(0);
    expect(some.counts.memoryShown).toBeLessThan(some.counts.memoryTotal);
    expect(some.text).toContain("DuckDB");
    expect(some.text).not.toContain("weekly reports");
    const many = await previewSendBack(env.nomad, { agent: "Kestrel", memory: Array.from({ length: 40 }, (_, i) => ({ content: `Long note number ${i}: ${"words ".repeat(30)}` })) });
    applySendBack(env.nomad, many.id, many.token);
    const tiny = await borrowAgent(env.nomad, "Kestrel", { maxChars: 2000 });
    expect(tiny.text.length).toBeLessThan(2600);
    expect(tiny.truncated).toBe(true);
  });

  it("says when an agent is not in the home", async () => {
    await expect(borrowAgent(env.nomad, "Nobody")).rejects.toThrow(/No agent "Nobody"/);
  });

  it("marks an agent that came from a package as made by others", async () => {
    await gatherAgents(env.nomad);
    const out = join(env.home, "k.nomad");
    await env.nomad.exportAgent({ kind: "stored", agentId: homeAgents(env.nomad).find((a) => a.name === "Kestrel")!.id }, { outPath: out });
    // A fresh store, as on another computer.
    const { Nomad } = await import("@nomad/migration");
    const other = new Nomad({ home: join(env.home, ".nomad-other") });
    try {
      await other.importPackage({ path: out });
      expect(homeAgents(other)[0].fromOthers).toBe(true);
      const r = await borrowAgent(other, "Kestrel");
      expect(r.fromOthers).toBe(true);
      expect(r.text).toContain("someone else may have made");
    } finally {
      other.close();
    }
  });
});

describe("your Nomad: send back", () => {
  it("adds new notes as a new version after the preview is approved, and marks other copies behind", async () => {
    await gatherAgents(env.nomad);
    const k = homeAgents(env.nomad).find((a) => a.name === "Kestrel")!;
    const v = versions(k.id);
    const p = await previewSendBack(env.nomad, { agent: "Kestrel", memory: [{ title: "Coffee", content: "Ada drinks her coffee black." }], app: "Claude Code" });
    expect(p.summary).toMatchObject({ add: 1, update: 0, unresolved: 0 });
    expect(p.secretsRedacted).toBe(0); // what the home already redacted is not counted again
    // The preview writes nothing.
    expect(versions(k.id)).toBe(v);
    expect(() => applySendBack(env.nomad, p.id, "wrong")).toThrow(/does not match/);
    const r = applySendBack(env.nomad, p.id, p.token);
    expect(r.added).toBe(1);
    expect(versions(k.id)).toBe(v + 1);
    const doc = env.nomad.store.latestDocument(k.id)!;
    expect(doc.memory.some((m) => m.content === "Ada drinks her coffee black." && m.title === "Coffee")).toBe(true);
    expect(env.nomad.store.listVersions(k.id)[0].reason).toBe("Sent back from Claude Code");
    // The OpenClaw copy does not have it yet.
    expect(r.behind.map((c) => c.adapter)).toEqual(["openclaw"]);
    expect(homeAgents(env.nomad).find((a) => a.id === k.id)!.copies[0].behind).toBe(true);
    expect(env.nomad.history()[0].kind).toBe("send-back");
    // A preview is used once.
    expect(() => applySendBack(env.nomad, p.id, p.token)).toThrow(/expired/);
  });

  it("skips what the home already has and refuses an empty send back", async () => {
    await gatherAgents(env.nomad);
    const p = await previewSendBack(env.nomad, { agent: "Kestrel", memory: [{ content: "The project codename is Harmattan." }] });
    expect(p.summary.add).toBe(0);
    expect(p.changes[0].reason).toBe("already in your home");
    expect(() => applySendBack(env.nomad, p.id, p.token)).toThrow(/Nothing to send back/);
    const twice = await previewSendBack(env.nomad, { agent: "Kestrel", memory: [{ content: "Same note." }, { content: "Same  note." }] });
    expect(twice.summary.add).toBe(1);
    await expect(previewSendBack(env.nomad, { agent: "Kestrel" })).rejects.toThrow(/nothing to send back/i);
  });

  it("redacts secrets in what is sent back", async () => {
    await gatherAgents(env.nomad);
    const p = await previewSendBack(env.nomad, { agent: "Kestrel", memory: [{ content: `The test key is ${FAKE_OPENAI_KEY}` }] });
    expect(p.secretsRedacted).toBeGreaterThan(0);
    applySendBack(env.nomad, p.id, p.token);
    const k = homeAgents(env.nomad).find((a) => a.name === "Kestrel")!;
    expect(JSON.stringify(env.nomad.store.latestDocument(k.id))).not.toContain(FAKE_OPENAI_KEY);
  });

  it("updates an entry changed only in the chat, and asks when it changed in both places", async () => {
    await gatherAgents(env.nomad);
    const k = homeAgents(env.nomad).find((a) => a.name === "Kestrel")!;
    const borrowed = await borrowAgent(env.nomad, "Kestrel");
    const entry = env.nomad.store.latestDocument(k.id)!.memory[0];

    // Changed only in the chat since the borrowed version: an update.
    const p1 = await previewSendBack(env.nomad, { agent: "Kestrel", baseVersion: borrowed.agent.version, memory: [{ id: entry.id, content: "Changed in chat A." }] });
    expect(p1.summary).toMatchObject({ update: 1, unresolved: 0 });
    applySendBack(env.nomad, p1.id, p1.token);
    const updated = env.nomad.store.latestDocument(k.id)!.memory.find((m) => m.id === entry.id)!;
    expect(updated.content).toBe("Changed in chat A.");
    expect(updated.kind).toBe(entry.kind); // what the change did not mention is kept

    // Another chat changed the same entry from the old version: both changed.
    const p2 = await previewSendBack(env.nomad, { agent: "Kestrel", baseVersion: borrowed.agent.version, memory: [{ id: entry.id, content: "Changed in chat B." }] });
    expect(p2.summary).toMatchObject({ conflicts: 1, unresolved: 1 });
    expect(p2.changes[0].home).toContain("Changed in chat A.");
    expect(() => applySendBack(env.nomad, p2.id, p2.token)).toThrow(/Choose which version/);

    const keep = await previewSendBack(env.nomad, { agent: "Kestrel", baseVersion: borrowed.agent.version, memory: [{ id: entry.id, content: "Changed in chat B." }], prefer: { [`memory:${entry.id}`]: "home" } });
    expect(keep.summary).toMatchObject({ unresolved: 0, update: 0, skipped: 1 });

    const use = await previewSendBack(env.nomad, { agent: "Kestrel", baseVersion: borrowed.agent.version, memory: [{ id: entry.id, content: "Changed in chat B." }], prefer: { [`memory:${entry.id}`]: "incoming" } });
    expect(use.summary).toMatchObject({ unresolved: 0, update: 1 });
    applySendBack(env.nomad, use.id, use.token);
    expect(env.nomad.store.latestDocument(k.id)!.memory.find((m) => m.id === entry.id)!.content).toBe("Changed in chat B.");

    // A chat holding the old content does not undo the newer home.
    const stale = await previewSendBack(env.nomad, { agent: "Kestrel", baseVersion: borrowed.agent.version, memory: [{ id: entry.id, content: entry.content }] });
    expect(stale.changes[0].reason).toBe("your home has a newer version of this entry");
  });

  it("refuses a preview made before the home changed", async () => {
    await gatherAgents(env.nomad);
    const a = await previewSendBack(env.nomad, { agent: "Kestrel", memory: [{ content: "First." }] });
    const b = await previewSendBack(env.nomad, { agent: "Kestrel", memory: [{ content: "Second." }] });
    applySendBack(env.nomad, a.id, a.token);
    expect(() => applySendBack(env.nomad, b.id, b.token)).toThrow(/changed in your home since this preview/);
  });

  it("reads what an agent learned in another app, and never deletes from the home", async () => {
    await gatherAgents(env.nomad);
    const k = homeAgents(env.nomad).find((a) => a.name === "Kestrel")!;
    // Bring Kestrel into a Claude Code project.
    const dest = join(env.home, "proj");
    mkdirSync(dest, { recursive: true });
    const plan = await env.nomad.plan({ source: { kind: "stored", agentId: k.id }, destination: { adapter: "claude-code", root: dest }, mode: "merge" });
    const receipt = await env.nomad.execute(plan.id, { runCommands: true }, { token: plan.token });
    expect(receipt.status).toBe("success");
    expect(homeAgents(env.nomad).find((a) => a.id === k.id)!.copies.every((c) => !c.behind)).toBe(true);

    // Kestrel learns something in Claude Code.
    const claudeMd = join(dest, "CLAUDE.md");
    const original = readFileSync(claudeMd, "utf8");
    writeFileSync(claudeMd, original + "\n## Learned\n\nAda moved the Friday report to Thursdays.\n");
    const from = { adapter: "claude-code", root: dest, nativeId: plan.destination.nativeId };
    const p = await previewSendBack(env.nomad, { agent: k.id, from });
    expect(p.from).toContain("Claude Code");
    expect(p.summary.add + p.summary.update).toBeGreaterThan(0);
    expect(p.summary.unresolved).toBe(0);
    const files = treeHash(dest);
    const r = applySendBack(env.nomad, p.id, p.token);
    expect(treeHash(dest)).toBe(files); // the app copy is only read
    const doc = env.nomad.store.latestDocument(k.id)!;
    expect(JSON.stringify(doc)).toContain("Ada moved the Friday report to Thursdays.");
    // Every memory entry the home had is still there.
    const before = env.nomad.store.versionDocument(k.id, r.version - 1)!;
    for (const m of before.memory) expect(doc.memory.some((x) => x.id === m.id)).toBe(true);
    // The OpenClaw copy is behind now; the Claude Code copy has everything.
    const copies = homeAgents(env.nomad).find((a) => a.id === k.id)!.copies;
    expect(copies.find((c) => c.adapter === "openclaw")!.behind).toBe(true);
    expect(copies.find((c) => c.adapter === "claude-code")!.behind).toBe(false);

    // Sending back again finds nothing new.
    const again = await previewSendBack(env.nomad, { agent: k.id, from });
    expect(again.summary.add + again.summary.update).toBe(0);
  });

  it("leaves skills and tools out unless asked, and refuses a copy of another agent", async () => {
    await gatherAgents(env.nomad);
    const home = homeAgents(env.nomad);
    const k = home.find((a) => a.name === "Kestrel")!;
    const skill = join(env.home, ".openclaw/workspace/skills/sky-watch/SKILL.md");
    mkdirSync(join(skill, ".."), { recursive: true });
    writeFileSync(skill, "---\nname: sky-watch\ndescription: Say when it will rain.\n---\n\nCheck the radar.\n");
    appendFileSync(join(env.home, ".openclaw/workspace/MEMORY.md"), "\n- Ada bought an umbrella.\n");
    const from = { adapter: "openclaw", root: join(env.home, ".openclaw"), nativeId: k.copies[0].nativeId };
    const p = await previewSendBack(env.nomad, { agent: k.id, from });
    expect(p.notIncluded.join(" ")).toContain("sky-watch");
    expect(p.changes.some((c) => c.category === "skills")).toBe(false);
    const withSkills = await previewSendBack(env.nomad, { agent: k.id, from, include: ["skills"] });
    expect(withSkills.changes.some((c) => c.category === "skills" && c.action === "add" && c.label === "sky-watch")).toBe(true);

    const other = home.find((a) => a.id !== k.id && a.copies.length)!;
    const otherFrom = { adapter: other.copies[0].adapter, root: other.copies[0].root, nativeId: other.copies[0].nativeId };
    await expect(previewSendBack(env.nomad, { agent: k.id, from: otherFrom })).rejects.toThrow(/belongs to another agent/);
  });
});
