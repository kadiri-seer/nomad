import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Wording rules for the Priors and ElizaOS work (README, site, docs, guide). */
const ROOT = resolve(__dirname, "../..");
const FILES = [
  "README.md",
  "apps/web/app/docs/adapters/page.tsx",
  "apps/web/app/docs/page.tsx",
  "apps/web/app/page.tsx",
  "docs/STATUS.md",
  "docs/guides/priors-setups.md",
  "docs/security/model.md",
  "packages/adapters/src/catalog.ts",
  "packages/adapters/src/known-servers.ts",
  "packages/adapters/src/elizaos.ts",
  "packages/adapters/src/elizaos-known-plugins.ts"
];
const FORBIDDEN = [/supports priors/i, /priors integration/i, /\bofficial\b/i, /\bpartner\b/i, /\$priors/i, /airdrop/i, /token launch/i];

describe("wording", () => {
  for (const f of FILES) {
    it(`${f} follows the wording rules`, () => {
      const text = readFileSync(join(ROOT, f), "utf8");
      for (const re of FORBIDDEN) expect(re.test(text), `${f} must not contain ${re}`).toBe(false);
      expect(/(?<!Robin)Hood Chain/.test(text), `${f} must say "Robinhood Chain"`).toBe(false);
    });
  }
});
