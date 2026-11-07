import { timingSafeEqual } from "node:crypto";
import type { Nomad } from "@nomad/migration";

export const SESSION_COOKIE = "nomad_session";

/** The dashboard and its API exist only when started by `nomad ui` on this machine. */
export function localEnabled(): boolean {
  return process.env.NOMAD_LOCAL === "1" && typeof process.env.NOMAD_LOCAL_TOKEN === "string" && process.env.NOMAD_LOCAL_TOKEN.length >= 16;
}

export function tokenMatches(candidate: string | undefined | null): boolean {
  const expected = process.env.NOMAD_LOCAL_TOKEN;
  if (!candidate || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function allowedHosts(): Set<string> {
  const port = process.env.PORT ?? "4317";
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

/**
 * Reject anything that is not a same-origin request from this machine with a
 * valid session: protects against other sites (CSRF) and DNS rebinding.
 */
export function checkRequest(req: Request, cookieValue: string | undefined): { ok: true } | { ok: false; status: number; error: string } {
  if (!localEnabled()) return { ok: false, status: 404, error: "The local API is only available when Nomad runs on your machine (nomad ui)." };
  const host = req.headers.get("host") ?? "";
  if (!allowedHosts().has(host)) return { ok: false, status: 403, error: "Requests must come from this machine." };
  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ""))) return { ok: false, status: 403, error: "Cross site requests are not allowed." };
    if (req.headers.get("x-nomad") !== "1") return { ok: false, status: 403, error: "Missing request header." };
  }
  if (!tokenMatches(cookieValue)) return { ok: false, status: 401, error: "Session expired. Open the link printed by nomad ui again." };
  return { ok: true };
}

const g = globalThis as unknown as { __nomad?: Nomad };

export async function engine(): Promise<Nomad> {
  if (!g.__nomad) {
    const { Nomad } = await import("@nomad/migration");
    g.__nomad = new Nomad({ home: process.env.NOMAD_HOME });
  }
  return g.__nomad;
}
