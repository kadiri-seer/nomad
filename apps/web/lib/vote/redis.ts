/** A small Redis client: Upstash over REST on the website, an in-memory stand-in in tests. */

export interface RedisLike {
  cmd(args: (string | number)[]): Promise<unknown>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class UpstashRedis implements RedisLike {
  constructor(
    private url: string,
    private token: string,
    private fetchImpl: FetchLike = fetch
  ) {}
  async cmd(args: (string | number)[]) {
    const res = await this.fetchImpl(this.url.replace(/\/$/, ""), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store"
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || body.error) throw new Error(`Storage error: ${body.error ?? res.status}`);
    return body.result;
  }
}

/** Implements the handful of commands Nomad uses, with Redis's return values. */
export class MemoryRedis implements RedisLike {
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private sets = new Map<string, Set<string>>();
  async cmd(args: (string | number)[]) {
    const [op, key, ...rest] = args.map(String);
    const hash = () => {
      const h = this.hashes.get(key) ?? new Map<string, string>();
      this.hashes.set(key, h);
      return h;
    };
    switch (op.toUpperCase()) {
      case "HSET":
        hash().set(rest[0], rest[1]);
        return 1;
      case "HSETNX":
        if (hash().has(rest[0])) return 0;
        hash().set(rest[0], rest[1]);
        return 1;
      case "HGET":
        return this.hashes.get(key)?.get(rest[0]) ?? null;
      case "HGETALL":
        return [...(this.hashes.get(key)?.entries() ?? [])].flat();
      case "HINCRBY": {
        const v = Number(hash().get(rest[0]) ?? "0") + Number(rest[1]);
        hash().set(rest[0], String(v));
        return v;
      }
      case "SADD": {
        const s = this.sets.get(key) ?? new Set<string>();
        this.sets.set(key, s);
        if (s.has(rest[0])) return 0;
        s.add(rest[0]);
        return 1;
      }
      case "INCR": {
        const v = Number(this.strings.get(key) ?? "0") + 1;
        this.strings.set(key, String(v));
        return v;
      }
      case "EXPIRE":
        return 1;
      default:
        throw new Error(`MemoryRedis does not implement ${op}`);
    }
  }
}

export type RedisEnv = { url: string; token: string; urlName: string; tokenName: string };

const PAIRS: [RegExp, string][] = [
  [/^(.*?)REST_API_URL$/, "REST_API_TOKEN"],
  [/^(.*?)UPSTASH_REDIS_REST_URL$/, "UPSTASH_REDIS_REST_TOKEN"]
];

/**
 * Finds the Upstash REST connection Vercel added. Vercel puts the chosen prefix in front
 * (KV_REST_API_URL by default, NOMAD_REST_API_URL with the prefix NOMAD, ...), so any prefix
 * is accepted as long as the matching token has the same prefix. Upstash hosts are preferred,
 * and the read-only token is never used.
 */
export function findRedisEnv(env: Record<string, string | undefined> = process.env): RedisEnv | null {
  const names = Object.keys(env).sort((a, b) => a.length - b.length || a.localeCompare(b));
  const found: RedisEnv[] = [];
  for (const [re, tokenSuffix] of PAIRS) {
    for (const urlName of names) {
      const m = re.exec(urlName);
      if (!m) continue;
      const tokenName = `${m[1]}${tokenSuffix}`;
      const url = env[urlName];
      const token = env[tokenName];
      if (url && token && /^https:\/\//.test(url)) found.push({ url, token, urlName, tokenName });
    }
  }
  return found.find((f) => /upstash\.io/i.test(f.url)) ?? found[0] ?? null;
}

/** Names (never values) of variables that look like storage settings, for the health check. */
export function storageVariableNames(env: Record<string, string | undefined> = process.env): string[] {
  return Object.keys(env)
    .filter((k) => /(KV_|REDIS|UPSTASH|REST_API)/.test(k))
    .sort();
}

export function redisFromEnv(env: Record<string, string | undefined> = process.env): RedisLike | null {
  const found = findRedisEnv(env);
  return found ? new UpstashRedis(found.url, found.token) : null;
}

/** Redis returns hashes as [field, value, field, value, ...] over REST. */
export function hashToObject(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) out[k] = String(v);
  }
  return out;
}
