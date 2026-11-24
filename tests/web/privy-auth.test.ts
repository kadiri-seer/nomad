import { describe, expect, it } from "vitest";
import { privyUser } from "../../apps/web/lib/server/privy-auth";

/** Free operations go only to people Privy signed in for this app: the token's signature, issuer, audience and age. */

const APP = "test-app";
const b64 = (b: Uint8Array | string) => Buffer.from(typeof b === "string" ? b : b).toString("base64url");

async function setup() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const fetchImpl = (async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1" }] }))) as unknown as typeof fetch;
  const sign = async (claims: Record<string, unknown>, key = pair.privateKey, alg = "ES256") => {
    const head = `${b64(JSON.stringify({ alg, typ: "JWT", kid: "k1" }))}.${b64(JSON.stringify(claims))}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(head)));
    return `${head}.${b64(sig)}`;
  };
  return { fetchImpl, sign };
}

const now = Date.parse("2026-11-24T12:00:00Z");
const good = { iss: "privy.io", aud: APP, sub: "did:privy:abc", exp: now / 1000 + 600 };

describe("privy sign-in check", () => {
  it("accepts a token Privy signed for this app", async () => {
    const { fetchImpl, sign } = await setup();
    expect(await privyUser(await sign(good), { appId: APP, now, fetchImpl })).toBe("did:privy:abc");
  });
  it("refuses tokens for another app, from another issuer, expired, unsigned or signed by someone else", async () => {
    const { fetchImpl, sign } = await setup();
    const o = { appId: APP, now, fetchImpl };
    expect(await privyUser(await sign({ ...good, aud: "other" }), o)).toBeNull();
    expect(await privyUser(await sign({ ...good, iss: "evil.io" }), o)).toBeNull();
    expect(await privyUser(await sign({ ...good, exp: now / 1000 - 1 }), o)).toBeNull();
    expect(await privyUser(await sign(good, undefined, "none"), o)).toBeNull();
    const stranger = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    expect(await privyUser(await sign(good, stranger.privateKey), o)).toBeNull();
    expect(await privyUser("not.a.token", o)).toBeNull();
    expect(await privyUser(null, o)).toBeNull();
  });
});
