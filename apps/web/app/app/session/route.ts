import { NextResponse } from "next/server";
import { localEnabled, SESSION_COOKIE, tokenMatches } from "@/lib/server/local";

export const dynamic = "force-dynamic";

/** Exchange the one time token printed by `nomad ui` for a session cookie. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  // Redirect to the exact host the browser used, so the cookie is sent back.
  const host = req.headers.get("host") ?? "";
  const port = process.env.PORT ?? "4317";
  const safeHost = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host) ? host : `127.0.0.1:${port}`;
  const target = new URL("/app", `http://${safeHost}`);
  const res = NextResponse.redirect(target, 303);
  if (localEnabled() && tokenMatches(token)) {
    res.cookies.set(SESSION_COOKIE, token!, { httpOnly: true, sameSite: "strict", path: "/", secure: false });
  }
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
