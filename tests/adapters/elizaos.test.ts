import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter, hasSecretsKey } from "@nomad/adapters";
import { setup, type Env } from "../helpers";
import { ELIZA_SECRET_VALUES, buildElizaOSPriors, trySymlink } from "../fixtures/priors";

let env: Env;
let project: string;
const eliza = getAdapter("elizaos");
beforeEach(() => {
  env = setup();
  const h = join(env.home, "eh");
  mkdirSync(h, { recursive: true });
  project = buildElizaOSPriors(h);
});
afterEach(() => env.cleanup());

const noSecretValues = (text: string) => {
  for (const v of ELIZA_SECRET_VALUES) expect(text.includes(v), `a ${v.length} character secret value leaked`).toBe(false);
};

describe("ElizaOS characters", () => {
  it("detects the project and discovers every JSON character", async () => {
    const det = await eliza.detect(project);
    expect(det.detected).toBe(true);
    const ids = (await eliza.discover(project)).map((r) => r.nativeId).sort();
    expect(ids).toEqual(["priors-agent", "priors-mcp", "priors-top-secrets"]);
  });

  it("drops secrets on read and lists only their names", async () => {
    for (const id of ["priors-agent", "priors-top-secrets"]) {
      const r = await eliza.read!(project, id);
      noSecretValues(JSON.stringify(r));
      const names = r.notes.find((n) => n.message.startsWith("Secrets are never read"))!.message;
      for (const n of ["PRIORS_KEY_FILE", "PRIORS_KEY", "PRIORS_AGENT_ID", "PRIORS_OWNER_ENTITY_IDS", "PRIORS_PAY_HOSTS", "OPENROUTER_API_KEY"]) expect(names).toContain(n);
      expect(r.notes.some((n) => /only moved money for named ElizaOS entities/.test(n.message))).toBe(true);
    }
  });

  it("maps the character fields", async () => {
    const { doc } = await eliza.read!(project, "priors-agent");
    expect(doc.name).toBe("PriorsAgent");
    expect(doc.identity.persona).toBe("Pays x402 APIs for its operator.\nChecks a seller's record before paying.\nRepays on time.");
    expect(doc.identity.tone).toBe("careful, precise, brief");
    expect(doc.instructions.map((i) => i.title)).toEqual(["System", "Style (all)", "Style (chat)", "Style (post)"]);
    expect(doc.memory).toHaveLength(2);
    expect(doc.knowledge.map((k) => k.path)).toEqual(["./knowledge/priors.md"]);
    expect(doc.integrations.map((i) => i.name)).toEqual(["@elizaos/plugin-sql", "@elizaos/plugin-bootstrap", "@elizaos/plugin-openrouter", "@priors/plugin-elizaos"]);
    expect(doc.integrations[3].notes).toContain("priors-wallet (@priors/mcp)");
    const x = doc.extensions["x-elizaos"] as any;
    expect(x.bioShape).toBe("array");
    expect(x.topics).toEqual(["x402", "credit records"]);
    expect(x.settings).toEqual({ model: "openrouter/auto" });
  });

  it("reads MCP servers from settings.mcp", async () => {
    const { doc } = await eliza.read!(project, "priors-mcp");
    expect(doc.tools.map((t) => t.name)).toEqual(["priors-wallet", "priors"]);
    expect(doc.tools[1].mcp!.transport).toBe("http");
    expect((doc.extensions["x-elizaos"] as any).settings).toEqual({ mcp: { maxRetries: 2 } });
  });

  it("never executes a TypeScript character", async () => {
    const marker = join(env.home, "ran.txt");
    process.env.NOMAD_TEST_MARKER = marker;
    const r = await eliza.read!(project, "priors-agent");
    expect(existsSync(marker)).toBe(false);
    expect(r.notes.some((n) => /TypeScript character found \(src\/character\.ts\), not imported/.test(n.message))).toBe(true);
    delete process.env.NOMAD_TEST_MARKER;
  });

  it("handles malformed, missing, oversized and symlinked characters", async () => {
    writeFileSync(join(project, "characters/broken.json"), '{"name": "x", "secrets": {"K": "never-show-this"');
    await expect(eliza.read!(project, "broken")).rejects.toThrow(/not valid JSON/);
    await eliza.read!(project, "broken").catch((e) => expect(String(e.message)).not.toContain("never-show-this"));
    writeFileSync(join(project, "characters/nobio.json"), JSON.stringify({ name: "NoBio", secrets: { PRIORS_OWNER_ENTITY_IDS: "*" } }));
    const nb = await eliza.read!(project, "nobio");
    expect(nb.doc.identity.persona).toBeUndefined();
    expect(JSON.stringify(nb)).not.toContain('"*"');
    writeFileSync(join(project, "characters/huge.json"), JSON.stringify({ name: "Huge", bio: "x", messageExamples: [["y".repeat(300 * 1024)]] }));
    const hg = await eliza.read!(project, "huge");
    expect((hg.doc.extensions["x-elizaos"] as any).messageExamples).toBeUndefined();
    expect(hg.notes.some((n) => /messageExamples is larger than 256 KB/.test(n.message))).toBe(true);
    if (trySymlink(join(project, "characters/priors-agent.json"), join(project, "characters/link.json"))) {
      await expect(eliza.read!(project, "link")).rejects.toThrow(/symlink/);
    }
  });

  it("writes a character without secrets and reads it back the same", async () => {
    const dest = join(env.home, "eliza-dest");
    mkdirSync(dest, { recursive: true });
    const plan = await env.nomad.plan({ source: { kind: "location", adapter: "elizaos", root: project, nativeId: "priors-agent" }, destination: { adapter: "elizaos", root: dest }, mode: "copy" });
    const receipt = await env.nomad.execute(plan.id);
    expect(receipt.status).toBe("success");
    const src = JSON.parse(readFileSync(join(project, "characters/priors-agent.json"), "utf8"));
    const out = JSON.parse(readFileSync(join(dest, `characters/${plan.destination.nativeId}.json`), "utf8"));
    expect(hasSecretsKey(out)).toBe(false);
    for (const k of ["bio", "style", "adjectives", "topics", "messageExamples", "postExamples", "plugins", "system", "username"]) expect(out[k], k).toEqual(src[k]);
    expect(out.settings.model).toBe("openrouter/auto");
    noSecretValues(JSON.stringify(out) + JSON.stringify(plan) + JSON.stringify(receipt));
    expect(plan.manualSteps.join("\n")).toContain("Set secrets in your own ElizaOS environment");
  });
});
