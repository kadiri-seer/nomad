import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { handleLocalApi } from "@nomad/local";
import { setup, type Env } from "../helpers";

let env: Env;
beforeEach(() => {
  env = setup();
});
afterEach(() => env.cleanup());

const ctx = () => ({ nomad: env.nomad, token: "t0ken", port: 4317 });
async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const req = new Request(`http://127.0.0.1:4317/api/local/${path}`, {
    method,
    headers: { host: "127.0.0.1:4317", cookie: "nomad_session=t0ken", ...(method === "POST" ? { "x-nomad": "1", "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const res = await handleLocalApi(req, ctx(), path.split("?")[0].split("/"));
  return { status: res.status, json: await res.json() };
}

describe("dashboard API: your Nomad", () => {
  it("gathers, lists, borrows and brings changes home from an app copy", async () => {
    const first = await call("GET", "home");
    expect(first.status).toBe(200);
    expect(first.json.agents).toEqual([]);
    expect((await call("POST", "home/gather", {})).json.gathered.length).toBeGreaterThan(0);
    const list = await call("GET", "home");
    const k = list.json.agents.find((a: any) => a.name === "Kestrel");
    expect(k.copies[0].adapter).toBe("openclaw");

    const b = await call("POST", "home/borrow", { agent: k.id });
    expect(b.json.text).toContain("# Borrowed agent: Kestrel");

    appendFileSync(join(env.home, ".openclaw/workspace/MEMORY.md"), "\n- Ada adopted a cat called Suya.\n");
    const p = await call("POST", "home/send-back", { agent: k.id, from: k.copies[0] });
    expect(p.status).toBe(200);
    expect(p.json.summary.add).toBe(1);
    const bad = await call("POST", "home/send-back/apply", { previewId: p.json.id, token: "nope" });
    expect(bad.status).toBe(400);
    const ok = await call("POST", "home/send-back/apply", { previewId: p.json.id, token: p.json.token });
    expect(ok.json.version).toBe(2);
    expect(JSON.stringify(env.nomad.store.latestDocument(k.id))).toContain("Suya");

    const apps = await call("GET", "connect");
    expect(apps.json.map((a: any) => a.app)).toContain("claude-code");
    expect((await call("POST", "home/nothing", {})).status).toBe(404);
  });

  it("needs a session like every other dashboard route", async () => {
    const req = new Request("http://127.0.0.1:4317/api/local/home", { headers: { host: "127.0.0.1:4317" } });
    expect((await handleLocalApi(req, ctx(), ["home"])).status).toBe(401);
  });
});
