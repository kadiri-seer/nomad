/**
 * Checks that a call comes from this repository's own GitHub Actions schedule, by its OpenID Connect token: signed by
 * GitHub, for this audience, from kadiri-seer/nomad on main. No shared secret is needed.
 */
const ISSUER = "https://token.actions.githubusercontent.com";
export const RUNNER_AUDIENCE = "nomad-agents";
export const RUNNER_REPOSITORY = "kadiri-seer/nomad";

type Jwk = JsonWebKey & { kid?: string };
let jwks: { at: number; keys: Jwk[] } | null = null;

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

async function keys(fetchImpl: typeof fetch, force = false): Promise<Jwk[]> {
  if (!force && jwks && Date.now() - jwks.at < 3_600_000) return jwks.keys;
  const r = await fetchImpl(`${ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(10_000) });
  const j = (await r.json()) as { keys: Jwk[] };
  jwks = { at: Date.now(), keys: j.keys };
  return j.keys;
}

export type OidcClaims = { iss: string; aud: string | string[]; repository: string; ref: string; exp: number; nbf?: number; event_name?: string };

export async function verifyGithubToken(token: string, opts: { audience?: string; repository?: string; now?: number; fetchImpl?: typeof fetch } = {}): Promise<OidcClaims> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("not a token");
  const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { alg: string; kid: string };
  if (header.alg !== "RS256") throw new Error("unexpected algorithm");
  const fetchImpl = opts.fetchImpl ?? fetch;
  let jwk = (await keys(fetchImpl)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keys(fetchImpl, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error("bad signature");
  const c = JSON.parse(new TextDecoder().decode(b64url(p))) as OidcClaims;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== ISSUER) throw new Error("wrong issuer");
  if (!aud.includes(opts.audience ?? RUNNER_AUDIENCE)) throw new Error("wrong audience");
  if (c.repository !== (opts.repository ?? RUNNER_REPOSITORY)) throw new Error("wrong repository");
  if (c.ref !== "refs/heads/main") throw new Error("wrong branch");
  if (!(c.exp > now - 60) || (c.nbf && c.nbf > now + 60)) throw new Error("expired");
  return c;
}
