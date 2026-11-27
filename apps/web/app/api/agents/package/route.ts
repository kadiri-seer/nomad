import { MAX_PACKAGE_BYTES } from "@/lib/agent-package";
import { storePackage } from "@/lib/server/agent-keys";
import { deps, fail, json } from "@/lib/server/agent-routes";
import { rateLimited } from "@/lib/server/account-routes";

export const dynamic = "force-dynamic";

/**
 * Stores an encrypted package (the request body, raw bytes) and its key, for the wallet that signed. The package's
 * hash, key, wallet, time and signature come in headers. The file was encrypted in the creator's browser.
 */
export async function POST(req: Request) {
  if (await rateLimited(req, "agent-package", 10)) return json({ error: "Too many tries. Wait a minute." }, 429);
  const d = deps();
  if (typeof d === "string") return json({ error: d }, 503);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_PACKAGE_BYTES) return json({ error: "The package is larger than 4 MB." }, 413);
  try {
    const blob = new Uint8Array(await req.arrayBuffer());
    const h = (n: string) => req.headers.get(n) ?? "";
    const out = await storePackage(d, { blob, packageHash: h("x-nomad-package-hash"), keyHex: h("x-nomad-key"), address: h("x-nomad-address"), issuedAt: h("x-nomad-issued-at"), signature: h("x-nomad-signature") });
    return json(out);
  } catch (e) {
    return fail(e);
  }
}
