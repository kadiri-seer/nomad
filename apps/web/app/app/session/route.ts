import { sessionResponse } from "@nomad/local";
import { localContext } from "@/lib/server/local";

export const dynamic = "force-dynamic";

/** Exchange the one time token printed by `nomad ui --dev` for a session cookie. */
export async function GET(req: Request) {
  const local = await localContext();
  if (!local) return Response.redirect(new URL("/app", req.url), 303);
  return sessionResponse(req, local);
}
