/** What the bounty routes share: the service, JSON errors, and reading a JSON body. */
import { json } from "./account-routes";
import { BountyError } from "./bounties";
import { bountyEnv } from "./bounty-env";

export { json };

/** Runs a bounty step and answers with its result, or with its error as JSON. */
export async function answer(f: (b: NonNullable<ReturnType<typeof bountyEnv>>) => Promise<unknown>) {
  const b = bountyEnv();
  if (!b) return json({ error: "Bounties are not set up on this site yet." }, 503);
  try {
    return json(await f(b));
  } catch (e) {
    if (e instanceof BountyError) return json({ error: e.message }, e.status);
    return json({ error: "Something went wrong. Nothing was changed. Try again." }, 502);
  }
}

export async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const j = await req.json();
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
