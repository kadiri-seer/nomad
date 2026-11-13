import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAdapterContract } from "@nomad/sdk";
import { getAdapter } from "@nomad/adapters";
import { jsonAgentAdapter } from "../../packages/sdk/examples/json-agent";
import { buildClaudeCode, buildCodex, buildHermes, buildOpenClaw } from "../fixtures/platforms";
import { ELIZA_SECRET_VALUES, FAKE_PRIORS_SECRETS, buildElizaOSPriors, buildClaudeCodePriors, buildCodexPriors, buildCursorPriors, buildGeminiPriors, buildHermesPriors } from "../fixtures/priors";

const failures = (r: Awaited<ReturnType<typeof runAdapterContract>>) => r.filter((x) => !x.ok);

describe("adapter contract", () => {
  it("the SDK example adapter passes", async () => {
    const r = await runAdapterContract(jsonAgentAdapter, {
      build: (home) => {
        const root = join(home, "json-agents");
        mkdirSync(join(root, "agents"), { recursive: true });
        writeFileSync(join(root, "agents", "helper.json"), JSON.stringify({ name: "Helper", system_prompt: "Help.", memories: ["a", "b"], mcp: { fs: { command: "npx", args: ["fs"] } } }));
        return root;
      },
      nativeId: "helper",
      expect: { memory: 2, tools: 1 }
    });
    expect(failures(r)).toEqual([]);
  });

  const direct: Array<[string, (h: string) => string, string, Record<string, number>]> = [
    ["openclaw", buildOpenClaw, "main", { instructions: 3, memory: 8, skills: 1, workflows: 1 }],
    ["claude-code", buildClaudeCode, "main", { instructions: 1, skills: 2, tools: 1 }],
    ["codex", buildCodex, "main", { instructions: 1, skills: 2, tools: 1 }],
    ["hermes", buildHermes, "default", { memory: 6, skills: 1, tools: 1, workflows: 1 }]
  ];
  for (const [id, build, nativeId, expectCounts] of direct) {
    it(`${id} passes the contract`, async () => {
      const r = await runAdapterContract(getAdapter(id), { build, nativeId, expect: expectCounts });
      expect(failures(r)).toEqual([]);
    });
  }

  // Priors setups with planted wallet keys: the read, the plan, the receipt and every
  // written file are checked for them.
  const priors: Array<[string, (h: string) => string, string, Record<string, number>]> = [
    ["claude-code", buildClaudeCodePriors, "main", { tools: 3, skills: 1 }],
    ["codex", buildCodexPriors, "main", { instructions: 1, tools: 2 }],
    ["hermes", buildHermesPriors, "default", { memory: 6, tools: 3, skills: 2 }],
    ["cursor", buildCursorPriors, "main", { instructions: 1, tools: 2 }],
    ["gemini-cli", buildGeminiPriors, "main", { instructions: 1, tools: 2 }]
  ];
  it("elizaos passes the contract with planted secrets", async () => {
    const r = await runAdapterContract(getAdapter("elizaos"), { build: buildElizaOSPriors, nativeId: "priors-agent", expect: { instructions: 1, memory: 2, tools: 0 }, secrets: [...FAKE_PRIORS_SECRETS, ...ELIZA_SECRET_VALUES] });
    expect(failures(r)).toEqual([]);
  });

  for (const [id, build, nativeId, expectCounts] of priors) {
    it(`${id} passes the contract with a Priors setup and planted keys`, async () => {
      const r = await runAdapterContract(getAdapter(id), { build, nativeId, expect: expectCounts, secrets: FAKE_PRIORS_SECRETS });
      expect(failures(r)).toEqual([]);
      expect(r.some((x) => x.name === "never writes secret values")).toBe(true);
    });
  }

  for (const id of ["elizaos", "cursor", "windsurf", "cline", "roo-code", "continue", "opencode", "goose", "aider", "gemini-cli", "generic", "chatgpt", "crewai", "letta"]) {
    it(`${id} passes the write contract`, async () => {
      const r = await runAdapterContract(getAdapter(id));
      expect(failures(r)).toEqual([]);
    });
  }
});
