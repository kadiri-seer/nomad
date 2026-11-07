import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { handleLocalApi, hostAllowed, sessionResponse } from "@nomad/local";
import type { Nomad } from "@nomad/migration";

/**
 * `nomad ui`: one small Node server on 127.0.0.1 that serves the exported
 * dashboard pages and answers the local API with the CLI's own engine. No
 * Next.js runtime is needed, so this works from the npm package.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json"
};

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

/** Where the exported site lives: next to the bundled CLI (npm), or in the repository after `pnpm build:ui`. */
export function findSite(here: string): string | null {
  const candidates = [resolve(here, "../web"), resolve(here, "../../web/.next-export"), resolve(process.cwd(), "apps/web/.next-export")];
  return candidates.find((d) => existsSync(join(d, "app.html"))) ?? null;
}

function fileFor(site: string, pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  const base = normalize(join(site, rel));
  if (base !== site && !base.startsWith(site + sep)) return null;
  for (const p of [base, `${base}.html`, join(base, "index.html")]) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* try the next form */
    }
  }
  return null;
}

async function toRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  else if (Array.isArray(v)) headers.set(k, v.join(", "));
  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 130 * 1024 * 1024) throw new Error("Request too large.");
      chunks.push(c as Buffer);
    }
    const all = Buffer.concat(chunks);
    body = all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
  }
  return new Request(url, { method: req.method, headers, body });
}

async function send(res: ServerResponse, r: Response) {
  const headers: Record<string, string | string[]> = { ...SECURITY_HEADERS };
  r.headers.forEach((v, k) => {
    if (k === "set-cookie") return;
    headers[k] = v;
  });
  const cookies = r.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(r.status, headers);
  res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
}

export function startUi(opts: { nomad: Nomad; site: string; port: number; token: string }) {
  const { nomad, site, port, token } = opts;
  const ctx = { nomad, token, port };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const host = req.headers.host ?? "";
      // Refuse other host names entirely: this blocks DNS rebinding.
      if (!hostAllowed(new Request(url, { headers: { host } }), port)) {
        res.writeHead(403, { "Content-Type": "text/plain" }).end("Requests must come from this machine.");
        return;
      }
      if (url.pathname === "/app/session") return send(res, sessionResponse(await toRequest(req, url), ctx));
      if (url.pathname.startsWith("/api/local/")) {
        const path = url.pathname.slice("/api/local/".length).split("/").filter(Boolean).map(decodeURIComponent);
        return send(res, await handleLocalApi(await toRequest(req, url), ctx, path));
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      const file = fileFor(site, url.pathname === "/" ? "/index.html" : url.pathname);
      const path = file ?? join(site, "404.html");
      const type = TYPES[extname(path)] ?? "application/octet-stream";
      const immutable = url.pathname.startsWith("/_next/static/");
      res.writeHead(file ? 200 : 404, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
      res.end(req.method === "HEAD" ? undefined : readFileSync(path));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end((e as Error).message);
    }
  });
  return new Promise<typeof server>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok(server));
  });
}
