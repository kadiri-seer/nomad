const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

let lastTime = -1;
let lastRandom: number[] = [];

/**
 * Monotonic ULID generator. 48 bit millisecond timestamp followed by 80 bits of
 * randomness, Crockford base32 encoded. Sortable by creation time.
 */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand: number[];
  if (now === lastTime) {
    rand = [...lastRandom];
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i] < 31) {
        rand[i]++;
        break;
      }
      rand[i] = 0;
    }
  } else {
    const bytes = randomBytes(16);
    rand = Array.from(bytes, (b) => b % 32);
  }
  lastTime = now;
  lastRandom = rand;
  return time + rand.map((r) => CROCKFORD[r]).join("");
}

export function isUlid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
}

export function ulidTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(ch);
  return t;
}

/** Short random identifier for operations, plans and backups. */
export function shortId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

export function slugify(input: string, fallback = "agent"): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || fallback;
}
