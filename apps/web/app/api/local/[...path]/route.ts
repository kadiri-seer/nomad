import { handleLocalApi } from "@nomad/local";
import { engine, localContext } from "@/lib/server/local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

async function route(req: Request, ctx: Ctx) {
  const local = await localContext();
  if (!local) return Response.json({ error: "The local API is only available when Nomad runs on your machine (nomad ui)." }, { status: 404 });
  return handleLocalApi(req, { ...local, nomad: await engine() }, (await ctx.params).path);
}

export const GET = route;
export const POST = route;
