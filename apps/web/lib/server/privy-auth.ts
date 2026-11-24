/**
 * Checks a Privy access token (ES256 JWT) from the account pages, so free operations go only to people signed in
 * with Google on this site, not to any address that asks. Keys come from Privy's JWKS for this app, or from
 * PRIVY_VERIFICATION_KEY (the PEM key in Privy's dashboard) when that is set.
 */
import { PRIVY_APP_ID } from "../accounts/chain";

type Jwk = JsonWebKey & { kid?: string };
let cache: { at: number; keys: CryptoKey[] } | null = null;

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

async function keys(fetchImpl: typeof fetch, appId: string, force = false): Promise<CryptoKey[]> {
  // A forced reload (a token signed by a key we do not have) happens at most every five minutes.
  if (cache && Date.now() - cache.at < (force ? 300_000 : 3_600_000)) return cache.keys;
  const out: CryptoKey[] = [];
  const pem = process.env.PRIVY_VERIFICATION_KEY?.trim();
  if (pem) {
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    out.push(await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]));
  }
  try {
    const r = await fetchImpl(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`, { signal: AbortSignal.timeout(8_000) });
    const j = (await r.json()) as { keys?: Jwk[] };
    for (const k of j.keys ?? []) {
      if (k.kty !== "EC" || k.crv !== "P-256") continue;
      out.push(await crypto.subtle.importKey("jwk", { kty: k.kty, crv: k.crv, x: k.x, y: k.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]));
    }
  } catch {
    /* the PEM key, when set, still works */
  }
  if (out.length) cache = { at: Date.now(), keys: out };
  return out;
}

/** The Privy user id (DID) of a valid token for this app, or null. */
export async function privyUser(token: string | null | undefined, opts: { appId?: string; now?: number; fetchImpl?: typeof fetch } = {}): Promise<string | null> {
  const appId = opts.appId ?? PRIVY_APP_ID;
  if (!token || !appId) return null;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { alg?: string };
    if (header.alg !== "ES256") return null;
    const claims = JSON.parse(new TextDecoder().decode(b64url(p))) as { iss?: string; aud?: string | string[]; exp?: number; sub?: string };
    const now = Math.floor((opts.now ?? Date.now()) / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== "privy.io" || !aud.includes(appId) || !claims.exp || claims.exp < now || !claims.sub) return null;
    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = b64url(s);
    const fetchImpl = opts.fetchImpl ?? fetch;
    for (const force of [false, true]) {
      for (const key of await keys(fetchImpl, appId, force)) {
        if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data)) return claims.sub;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Whether this deployment can check tokens at all (for the status page). */
export async function privyKeysReady(fetchImpl: typeof fetch = fetch) {
  return PRIVY_APP_ID ? (await keys(fetchImpl, PRIVY_APP_ID)).length > 0 : false;
}
