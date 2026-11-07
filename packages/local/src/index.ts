import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { Nomad } from "@nomad/migration";

/**
 * The local dashboard API, written against the standard Request and Response
 * so the same code runs inside `nomad ui` (a plain Node server) and inside the
 * Next.js app during development.
 */

export const SESSION_COOKIE = "nomad_session";

export interface LocalContext {
  nomad: Nomad;
  /** One time token printed by nomad ui. */
  token: string;
  port: number | string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function tokenMatches(candidate: string | undefined | null, expected: string | undefined): boolean {
  if (!candidate || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function allowedHosts(port: number | string): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** True when the request comes from this machine under a host name we serve. */
export function hostAllowed(req: Request, port: number | string): boolean {
  return allowedHosts(port).has(req.headers.get("host") ?? "");
}

export function hasSession(req: Request, ctx: Pick<LocalContext, "token">): boolean {
  return tokenMatches(readCookie(req, SESSION_COOKIE), ctx.token);
}

/**
 * Reject anything that is not a same-origin request from this machine with a
 * valid session: protects against other sites (CSRF) and DNS rebinding.
 */
export function checkRequest(req: Request, ctx: Pick<LocalContext, "token" | "port">): { ok: true } | { ok: false; status: number; error: string } {
  if (!hostAllowed(req, ctx.port)) return { ok: false, status: 403, error: "Requests must come from this machine." };
  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin && !allowedHosts(ctx.port).has(origin.replace(/^https?:\/\//, ""))) return { ok: false, status: 403, error: "Cross site requests are not allowed." };
    if (req.headers.get("x-nomad") !== "1") return { ok: false, status: 403, error: "Missing request header." };
  }
  if (!hasSession(req, ctx)) return { ok: false, status: 401, error: "Session expired. Open the link printed by nomad ui again." };
  return { ok: true };
}

/** Exchange the one time token for a session cookie, then go to the dashboard. */
export function sessionResponse(req: Request, ctx: Pick<LocalContext, "token" | "port">): Response {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  // Redirect to the exact host the browser used, so the cookie is sent back.
  const host = req.headers.get("host") ?? "";
  const safeHost = allowedHosts(ctx.port).has(host) ? host : `127.0.0.1:${ctx.port}`;
  const headers = new Headers({ Location: `http://${safeHost}/app`, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
  if (tokenMatches(token, ctx.token)) headers.append("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token!)}; Path=/; HttpOnly; SameSite=Strict`);
  return new Response(null, { status: 303, headers });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function body<T = any>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

function safeSource(nomadHome: string, s: any) {
  if (!s || typeof s !== "object") throw new HttpError(400, "Missing source.");
  if (s.kind === "location") {
    if (typeof s.adapter !== "string" || typeof s.root !== "string" || typeof s.nativeId !== "string") throw new HttpError(400, "Incomplete location.");
    return { kind: "location" as const, adapter: s.adapter, root: s.root, nativeId: s.nativeId };
  }
  if (s.kind === "stored") return { kind: "stored" as const, agentId: String(s.agentId), version: s.version ? Number(s.version) : undefined };
  if (s.kind === "package") {
    const uploads = join(nomadHome, "uploads");
    const p = resolve(String(s.path));
    if (!p.startsWith(uploads + sep) || !/\.(nomad|agentpack|jetpack)$/.test(p)) throw new HttpError(400, "Packages must be uploaded first.");
    return { kind: "package" as const, path: p };
  }
  throw new HttpError(400, "Unknown source kind.");
}

async function handle(req: Request, ctx: LocalContext, path: string[]): Promise<Response> {
  const check = checkRequest(req, ctx);
  if (!check.ok) return json({ error: check.error }, check.status);
  const nomad = ctx.nomad;
  const home = nomad.store.home;
  const [a, b, c] = path;
  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  const seg = b === undefined ? "" : a === "agents" && b === "read" ? "/read" : "/:id";
  const route = `${req.method} ${a}${seg}${c ? `/${c}` : ""}`;
  if (route === "GET session") return json({ ok: true });

  switch (route) {
    case "GET overview": {
      const agents = nomad.listAgents();
      const ops = nomad.history().slice(0, 8).map((o) => ({ id: o.id, kind: o.kind, status: o.status, createdAt: o.createdAt, agent: o.receiptJson?.agent?.name, destination: o.destination }));
      return json({ agents: agents.length, locations: agents.reduce((n, x) => n + x.locations.length, 0), backups: nomad.backups().length, operations: ops, home });
    }
    case "GET adapters":
      return json(nomad.adapters());
    case "GET scan":
      return json(await nomad.scan());
    case "GET discover": {
      if (!q("adapter") || !q("root")) throw new HttpError(400, "adapter and root are required.");
      return json(await nomad.discover(q("adapter")!, q("root")!));
    }
    case "GET agents":
      return json(nomad.listAgents());
    case "POST agents/read": {
      const s = await body(req);
      const r = await nomad.readLocation(String(s.adapter), String(s.root), String(s.nativeId));
      return json({ agentId: r.doc.id, version: r.version, notes: r.notes, secrets: r.scan.findings.length });
    }
    case "GET agents/:id":
      return json(nomad.agentDetail(b));
    case "GET agents/:id/compare":
      return json(nomad.compareVersions(b, Number(q("left")), Number(q("right"))));
    case "POST agents/:id/duplicate": {
      const s = await body(req);
      return json(nomad.duplicateAgent(b, s.name || undefined));
    }
    case "POST agents/:id/backup": {
      const m = await nomad.backupAgent(b);
      return json({ id: m.id, files: m.files.length });
    }
    case "POST agents/:id/restore-version": {
      const s = await body(req);
      return json(nomad.restoreVersion(b, Number(s.version)));
    }
    case "POST compatibility": {
      const s = await body(req);
      const { analyzeCompatibility } = await import("@nomad/compatibility");
      const { getAdapter } = await import("@nomad/adapters");
      const loaded = await nomad.loadSource(safeSource(home, s.source));
      return json(analyzeCompatibility(loaded.doc, loaded.sourceAdapter?.info ?? null, getAdapter(String(s.platform)).info));
    }
    case "POST plan": {
      const s = await body(req);
      if (!s.destination?.adapter || !s.destination?.root) throw new HttpError(400, "Choose a destination platform and folder.");
      const plan = await nomad.plan({
        source: safeSource(home, s.source),
        destination: { adapter: String(s.destination.adapter), root: String(s.destination.root), nativeId: s.destination.nativeId || undefined },
        mode: ["merge", "copy", "replace"].includes(s.mode) ? s.mode : "merge",
        targetName: s.targetName || undefined,
        components: Array.isArray(s.components) ? s.components : undefined,
        includeFiles: !!s.includeFiles
      });
      return json(plan);
    }
    case "POST execute": {
      const s = await body(req);
      const receipt = await nomad.execute(String(s.planId), { replace: !!s.approvals?.replace, overwriteModified: !!s.approvals?.overwriteModified, broaderPermissions: !!s.approvals?.broaderPermissions }, { token: String(s.token) });
      return json(receipt);
    }
    case "POST export": {
      const s = await body(req);
      const dir = join(home, "exports");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const r = await nomad.exportAgent(safeSource(home, s.source), { outPath: dir, includeSecrets: !!s.includeSecrets, includeFiles: !!s.includeFiles, components: Array.isArray(s.components) && s.components.length ? s.components : undefined, format: s.format === "interchange" ? "interchange" : "nomad", sign: !!s.sign && s.format !== "interchange" });
      return json({ file: basename(r.path!), size: r.bytes.length, notIncluded: r.receipt.notIncluded, redacted: r.sanitize.redactedText, references: r.sanitize.strippedEnvValues.length, removedFiles: r.sanitize.removedFiles, signedBy: r.receipt.signedBy ?? null, receipt: r.receipt });
    }
    case "GET download": {
      const name = q("file") ?? "";
      if (!/^[\w.-]+\.(nomad|agentpack|jetpack)$/.test(name)) throw new HttpError(400, "Invalid file name.");
      const data = await readFile(join(home, "exports", name)).catch(() => {
        throw new HttpError(404, "File not found.");
      });
      return new Response(new Uint8Array(data), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
    }
    case "POST packages": {
      const data = new Uint8Array(await req.arrayBuffer());
      if (!data.length) throw new HttpError(400, "Empty upload.");
      if (data.length > 128 * 1024 * 1024) throw new HttpError(413, "The package is larger than 128 MB.");
      const v = nomad.validatePackage(data);
      if (!v.ok) return json({ ok: false, issues: v.issues });
      const dir = join(home, "uploads");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${Date.now()}-${v.doc!.id}.nomad`);
      await writeFile(path, data, { mode: 0o600 });
      return json({ ok: true, path, name: v.doc!.name, id: v.doc!.id, warnings: v.warnings, secrets: v.scan?.findings.length ?? 0, files: v.fileCount, counts: { instructions: v.doc!.instructions.length, memory: v.doc!.memory.length, skills: v.doc!.skills.length, tools: v.doc!.tools.length, workflows: v.doc!.workflows.length } });
    }
    case "POST import": {
      const s = await body(req);
      const src = safeSource(home, { kind: "package", path: s.path });
      return json(await nomad.importPackage({ path: src.path }));
    }
    case "GET history":
      return json(nomad.history(q("agent")));
    case "GET operations/:id": {
      const op = nomad.store.getOperation(String(b));
      if (!op) throw new HttpError(404, "Operation not found.");
      return json(op);
    }
    case "GET backups":
      return json(nomad.backups(q("agent")));
    case "GET backups/:id":
      return json(await nomad.previewRestore(b));
    case "POST backups/:id/restore":
      return json(await nomad.restore(b));
    case "GET settings":
      return json(nomad.settings());
    case "POST settings": {
      const s = await body(req);
      for (const [k, v] of Object.entries(s ?? {})) nomad.setSetting(k, v);
      return json(nomad.settings());
    }
  }
  return json({ error: "Not found." }, 404);
}

/** Handle /api/local/<path...>. */
export async function handleLocalApi(req: Request, ctx: LocalContext, path: string[]): Promise<Response> {
  try {
    return await handle(req, ctx, path);
  } catch (e) {
    const err = e as Error & { status?: number; hint?: string; code?: string };
    const status = err instanceof HttpError ? err.status : err.code === "approval-required" ? 409 : err.code === "not-found" ? 404 : 400;
    return json({ error: err.message, hint: err.hint, code: err.code }, status);
  }
}
