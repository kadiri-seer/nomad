import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@nomad/core";
import { Nomad } from "@nomad/migration";
import { buildAll } from "./fixtures/platforms";

export interface Env {
  home: string;
  nomadHome: string;
  roots: ReturnType<typeof buildAll>;
  nomad: Nomad;
  cleanup: () => void;
}

/** A fresh fake home with every platform fixture and an isolated Nomad store. */
export function setup(): Env {
  const home = mkdtempSync(join(tmpdir(), "nomad-test-"));
  process.env.NOMAD_FAKE_HOME = home;
  const nomadHome = join(home, ".nomad");
  process.env.NOMAD_HOME = nomadHome;
  const roots = buildAll(home);
  const nomad = new Nomad({ home: nomadHome });
  return {
    home,
    nomadHome,
    roots,
    nomad,
    cleanup: () => {
      nomad.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

/** Hash of every file below a directory, to prove a source was not modified. */
export function treeHash(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, `${rel}${name}/`);
      else parts.push(`${rel}${name}:${sha256(new Uint8Array(readFileSync(p)))}`);
    }
  };
  walk(dir, "");
  return sha256(parts.join("\n"));
}

export function emptyDir(home: string, name: string): string {
  const p = join(home, name);
  mkdirSync(p, { recursive: true });
  return p;
}

export function read(p: string): string {
  return readFileSync(p, "utf8");
}
