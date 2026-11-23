/**
 * Venin's agent check-up, run on what a move is about to write. Venin (https://venin.io, MIT) reads an agent's text
 * files and reports hidden text and planted orders (an infection), plus wide permissions, acting tools that run
 * with no one asking, and pay tools without limits. Nomad calls Venin's own published scanner and never changes
 * its verdicts: it shows every finding in the preview, and asks for approval before writing planted orders.
 *
 * The scanner takes `{"files": [{"path", "content"}]}` and answers with `{read, skipped, findings}` (or
 * `{"error": ...}`), the shape of Venin's `scan` export.
 */

export type VeninFinding = {
  organ: string;
  /** comment: hidden text that gives orders; order: planted orders; actor, wide, pay: risky setup. */
  check: string;
  kind: string;
  file: string;
  line: number;
  says: string;
  genes: string[];
};
export type VeninReport = { read: number; skipped: string[]; findings: VeninFinding[] };
export type VeninScanner = (files: { path: string; content: string }[]) => Promise<VeninReport>;

/**
 * The npm package with Venin's scanner. Null until Venin publishes it; NOMAD_VENIN_PACKAGE can name one to try.
 */
export const VENIN_PACKAGE: string | null = null;

/** Checks that count as an infection: orders someone planted, in plain or hidden text. */
export const INFECTION_CHECKS = new Set(["order", "comment"]);
export const isInfection = (f: VeninFinding) => INFECTION_CHECKS.has(f.check);

const MAX_FILE_BYTES = 512 * 1024;
const TEXT = new TextDecoder("utf-8", { fatal: true });

/** Text files only (as Venin reads them), each under 512 KB; binary files are left out. */
export function textFiles(files: { path: string; bytes: Uint8Array }[]): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const f of files) {
    if (f.bytes.length > MAX_FILE_BYTES) continue;
    try {
      out.push({ path: f.path.replace(/\\/g, "/"), content: TEXT.decode(f.bytes) });
    } catch {
      // not UTF-8 text
    }
  }
  return out;
}

/** Venin's answer, checked field by field. Throws on an error answer or anything out of shape. */
export function parseVeninReport(text: string): VeninReport {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("Venin's answer is not JSON");
  }
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  if (typeof o.error === "string") throw new Error(`Venin: ${o.error}`);
  if (!Number.isInteger(o.read) || !Array.isArray(o.findings)) throw new Error("Venin's answer is not a report");
  const s = (x: unknown, max = 400) => (typeof x === "string" ? x.slice(0, max) : "");
  return {
    read: o.read as number,
    skipped: (Array.isArray(o.skipped) ? o.skipped : []).filter((x): x is string => typeof x === "string"),
    findings: (o.findings as unknown[]).map((f) => {
      const x = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
      return {
        organ: s(x.organ, 40),
        check: s(x.check, 40),
        kind: s(x.kind, 40),
        file: s(x.file, 300),
        line: Number.isInteger(x.line) && (x.line as number) >= 0 ? (x.line as number) : 0,
        says: s(x.says),
        genes: (Array.isArray(x.genes) ? x.genes : []).filter((g): g is string => typeof g === "string").slice(0, 20)
      };
    })
  };
}

type VeninModule = { scan?: (files: string) => string; default?: unknown };

/**
 * Venin's scanner from its npm package, or null when it is not installed. The package may export `scan` directly
 * (a Node build) or need its WebAssembly started first (a web build's default export).
 */
export async function loadVenin(name: string | null = process.env.NOMAD_VENIN_PACKAGE || VENIN_PACKAGE): Promise<VeninScanner | null> {
  if (!name || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) return null;
  let mod: VeninModule;
  try {
    mod = (await import(name)) as VeninModule;
  } catch {
    return null;
  }
  if (typeof mod.scan !== "function" && typeof mod.default === "function") {
    try {
      await (mod.default as () => Promise<unknown>)();
    } catch {
      return null;
    }
  }
  const scan = typeof mod.scan === "function" ? mod.scan : typeof (mod.default as VeninModule | undefined)?.scan === "function" ? (mod.default as VeninModule).scan! : null;
  if (!scan) return null;
  return async (files) => parseVeninReport(scan(JSON.stringify({ files })));
}
