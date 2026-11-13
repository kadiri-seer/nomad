// Builds the Priors test fixtures into a throwaway home, for scripts/verify-real-apps.sh.
// Usage: tsx scripts/build-priors-fixtures.ts <home>
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildClaudeCodePriors, buildCodexPriors, buildHermesPriors } from "../tests/fixtures/priors";

const home = process.argv[2];
if (!home) throw new Error("Pass a home directory.");
for (const [dir, build] of [["priors-claude", buildClaudeCodePriors], ["priors-codex", buildCodexPriors], ["priors-hermes", buildHermesPriors]] as const) {
  mkdirSync(join(home, dir), { recursive: true });
  build(join(home, dir));
}
