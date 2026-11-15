import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fromUtf8 } from "@nomad/core";
import { drainSkippedLinks, readBytesIfExists, readTextIfExists } from "@nomad/core/node";
import { setup, type Env } from "../helpers";

/**
 * Agent files may be links (a CLAUDE.md kept in a dotfiles folder). A link is followed only to a
 * file inside the home folder or below the link's own folder, never to a credential file.
 */

let env: Env;
let outside: string;
beforeEach(() => {
  env = setup();
  outside = mkdtempSync(join(tmpdir(), "nomad-outside-"));
  drainSkippedLinks();
});
afterEach(() => {
  env.cleanup();
  rmSync(outside, { recursive: true, force: true });
});

const put = (p: string, s: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};
const link = (target: string, at: string) => {
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at);
};

const SECRET = "password hunter2hunter2xyz";

/** File links need extra rights on some Windows setups; these tests run wherever links can be made. */
const canLink = (() => {
  const d = mkdtempSync(join(tmpdir(), "nomad-linkprobe-"));
  try {
    writeFileSync(join(d, "t"), "");
    symlinkSync(join(d, "t"), join(d, "l"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();

describe.runIf(canLink)("linked agent files", () => {
  it("follows links into the home folder and inside the agent folder", async () => {
    const h = env.home;
    put(join(h, "dotfiles/claude/CLAUDE.md"), "# From dotfiles\n");
    link(join(h, "dotfiles/claude/CLAUDE.md"), join(h, "a/.claude/CLAUDE.md"));
    expect(await readTextIfExists(join(h, "a/.claude/CLAUDE.md"))).toBe("# From dotfiles\n");
    put(join(outside, "proj/docs/RULES.md"), "rules\n");
    link(join(outside, "proj/docs/RULES.md"), join(outside, "proj/AGENTS.md"));
    // Outside the home folder, a link that points below its own folder is fine.
    expect(await readTextIfExists(join(outside, "proj/AGENTS.md"))).toBe("rules\n");
    expect(drainSkippedLinks()).toEqual([]);
  });

  it("refuses links to credential files and to files outside the home folder", async () => {
    const h = env.home;
    const targets: Array<[string, string]> = [
      [".netrc", `machine api.example.com login me ${SECRET}`],
      [".ssh/id_ed25519", SECRET],
      [".aws/credentials", SECRET],
      [".config/gh/hosts.yml", SECRET],
      [".claude/.credentials.json", SECRET],
      ["project/.env", SECRET],
      [".bash_history", SECRET],
      ["keys/server.pem", SECRET]
    ];
    for (const [i, [rel, content]] of targets.entries()) {
      put(join(h, rel), content);
      link(join(h, rel), join(h, `agent${i}/.claude/CLAUDE.md`));
      expect(await readTextIfExists(join(h, `agent${i}/.claude/CLAUDE.md`)), rel).toBeNull();
      expect(await readBytesIfExists(join(h, `agent${i}/.claude/CLAUDE.md`)), rel).toBeNull();
    }
    put(join(outside, "elsewhere.txt"), SECRET);
    link(join(outside, "elsewhere.txt"), join(h, "far/.claude/CLAUDE.md"));
    expect(await readTextIfExists(join(h, "far/.claude/CLAUDE.md"))).toBeNull();
    expect(drainSkippedLinks()).toHaveLength(targets.length + 1);
  });

  it("an export never carries a linked credential file, and the preview says what was skipped", async () => {
    const h = join(env.home, "u");
    put(join(h, ".netrc"), `machine api.example.com login me ${SECRET}\n`);
    put(join(h, ".claude/settings.json"), "{}\n");
    link(join(h, ".netrc"), join(h, ".claude/CLAUDE.md"));
    const exp = await env.nomad.exportAgent({ kind: "location", adapter: "claude-code", root: join(h, ".claude"), nativeId: "main" }, { outPath: join(env.home, "x.nomad") });
    const all = [...exp.files.values()].map((b) => fromUtf8(b)).join("\n") + Buffer.from(exp.bytes).toString("latin1");
    expect(all.includes("hunter2hunter2xyz")).toBe(false);
    const r = await env.nomad.readLocation("claude-code", join(h, ".claude"), "main", { register: false });
    expect(r.notes.map((n) => n.message).join("\n")).toContain("Skipped 1 linked file(s) that point to a credential file or outside your home folder: ~/u/.claude/CLAUDE.md (not read, not copied)");
  });
});
