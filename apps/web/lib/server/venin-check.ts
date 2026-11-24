/**
 * Venin's scanner on the server, for agents: it checks the instructions a person gives an agent when it is created,
 * and every research answer before an agent's AI reads it. Venin's published package (WebAssembly, no network) is
 * loaded once; when it cannot load, the check says so and callers carry on with their other limits.
 */
import { isInfection, parseVeninReport } from "@nomad/security";

type Scan = (files: string) => string;
let loading: Promise<Scan | null> | null = null;

async function scanner(): Promise<Scan | null> {
  loading ??= import("@veninlab/venin").then((m) => (typeof m.scan === "function" ? (m.scan as Scan) : null)).catch(() => null);
  return loading;
}

export type VeninVerdict = { ran: boolean; planted: number; findings: number; says: string[] };

/** Venin's verdict on one piece of text, as a file at `path`. `planted` counts planted orders (order, comment, hidden). */
export async function veninCheck(path: string, text: string, scan?: Scan | null): Promise<VeninVerdict> {
  const s = scan === undefined ? await scanner() : scan;
  if (!s) return { ran: false, planted: 0, findings: 0, says: [] };
  try {
    const report = parseVeninReport(s(JSON.stringify({ files: [{ path, content: text.slice(0, 200_000) }] })));
    const planted = report.findings.filter(isInfection);
    return { ran: true, planted: planted.length, findings: report.findings.length, says: planted.map((f) => f.says).slice(0, 3) };
  } catch {
    return { ran: false, planted: 0, findings: 0, says: [] };
  }
}
