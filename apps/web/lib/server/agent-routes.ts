/** Shared setup for the paid-copy routes: what is configured, and errors as JSON. */
import { NextResponse } from "next/server";
import { redisFromEnv } from "../redis";
import { AGENTS_CONTRACT } from "../economy";
import { chainReader, filebaseUpload, KeyError, type Deps } from "./agent-keys";

const NO_STORE = { "cache-control": "no-store" };
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/** The routes' dependencies, or a reason they are not available on this deployment. */
export function deps(): Deps | string {
  if (!AGENTS_CONTRACT) return "Minting is not open yet.";
  const redis = redisFromEnv();
  if (!redis) return "Storage is not connected on this site.";
  const token = process.env.FILEBASE_IPFS_TOKEN?.trim();
  return { redis, ...chainReader(AGENTS_CONTRACT), upload: token ? filebaseUpload(token) : async () => { throw new KeyError(503, "Encrypted packages are not set up on this site yet."); } };
}

export function fail(e: unknown) {
  if (e instanceof KeyError) return json({ error: e.message }, e.status);
  return json({ error: "Something went wrong. Nothing was stored or sent. Try again." }, 502);
}
