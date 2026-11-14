import { findRedisEnv, storageVariableNames, UpstashRedis } from "@/lib/vote/redis";
import { json } from "@/lib/vote/server";

export const dynamic = "force-dynamic";

/**
 * Says whether vote storage is connected. Shows variable names only, never their values,
 * and pings the database with a harmless EXISTS on a nomad: key.
 */
export async function GET() {
  const found = findRedisEnv();
  let reachable: boolean | null = null;
  let error: string | null = null;
  if (found) {
    try {
      await new UpstashRedis(found.url, found.token).cmd(["EXISTS", "nomad:health"]);
      reachable = true;
    } catch (e) {
      reachable = false;
      error = (e as Error).message.slice(0, 120);
    }
  }
  return json({
    connected: found !== null,
    using: found ? { url: found.urlName, token: found.tokenName } : null,
    reachable,
    error,
    storageVariables: storageVariableNames(),
    environment: process.env.VERCEL_ENV ?? null
  });
}
