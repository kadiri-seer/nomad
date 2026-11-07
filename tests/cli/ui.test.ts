import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { Server } from "node:http";
import { startUi } from "../../apps/cli/src/ui";
import { setup, type Env } from "../helpers";

let env: Env;
let server: Server;
const PORT = 4471;
const TOKEN = "t".repeat(32);

function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, method: opts.method ?? "GET", headers: { host: `127.0.0.1:${PORT}`, ...opts.headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on("error", fail);
    req.end(opts.body);
  });
}

beforeEach(async () => {
  env = setup();
  const site = join(env.home, "site");
  mkdirSync(join(site, "app"), { recursive: true });
  writeFileSync(join(site, "app.html"), "<h1>dashboard</h1>");
  writeFileSync(join(site, "app/agents.html"), "<h1>agents</h1>");
  writeFileSync(join(site, "404.html"), "<h1>missing</h1>");
  writeFileSync(join(env.home, "secret.txt"), "do not serve");
  server = await startUi({ nomad: env.nomad, site, port: PORT, token: TOKEN });
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  env.cleanup();
});

describe("nomad ui server", () => {
  it("exchanges the token for a session and serves pages and the API", async () => {
    const s = await call(`/app/session?token=${TOKEN}`);
    expect(s.status).toBe(303);
    const cookie = String(s.headers["set-cookie"]).split(";")[0];
    expect(cookie).toContain("nomad_session=");
    expect((await call("/app/agents")).text).toContain("agents");
    const scan = await call("/api/local/scan", { headers: { cookie } });
    expect(scan.status).toBe(200);
    expect(JSON.parse(scan.text).map((p: any) => p.adapter)).toContain("openclaw");
  });

  it("refuses a wrong token, other hosts, cross-site writes and path traversal", async () => {
    const bad = await call("/app/session?token=wrong");
    expect(bad.headers["set-cookie"]).toBeUndefined();
    expect((await call("/api/local/agents")).status).toBe(401);
    expect((await call("/app", { headers: { host: `evil.example:${PORT}` } })).status).toBe(403);
    const cookie = String((await call(`/app/session?token=${TOKEN}`)).headers["set-cookie"]).split(";")[0];
    const body = JSON.stringify({ adapter: "openclaw", root: env.roots.openclaw, nativeId: "main" });
    expect((await call("/api/local/agents/read", { method: "POST", headers: { cookie, "content-type": "application/json" }, body })).status).toBe(403);
    expect((await call("/api/local/agents/read", { method: "POST", headers: { cookie, "x-nomad": "1", origin: "http://evil.example", "content-type": "application/json" }, body })).status).toBe(403);
    const ok = await call("/api/local/agents/read", { method: "POST", headers: { cookie, "x-nomad": "1", "content-type": "application/json" }, body });
    expect(ok.status).toBe(200);
    const trav = await call("/%2e%2e/secret.txt");
    expect(trav.status).toBe(404);
    expect(trav.text).not.toContain("do not serve");
  });
});
