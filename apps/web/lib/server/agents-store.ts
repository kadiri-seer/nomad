/** Where agents live between runs: Redis (the same store as credits and votes). */
import { getAddress, type Address } from "viem";
import type { RedisLike } from "../vote/redis";
import { hashToObject } from "../vote/redis";
import { NOTES_KEPT, NOTES_SHOWN, type AgentRecord, type Move, type Position } from "../agents/shared";

const AGENT = (id: string) => `nomad:agent:${id}`;
const OWNER = (a: Address) => `nomad:agents:owner:${a.toLowerCase()}`;
const ACCOUNT = (a: Address) => `nomad:agents:account:${a.toLowerCase()}`;
const DUE = "nomad:agents:due";
const MOVES = (id: string) => `nomad:agent:${id}:moves`;
const NOTES = (id: string) => `nomad:agent:${id}:notes`;
const POSITIONS = (id: string) => `nomad:agent:${id}:positions`;

export function agentStore(redis: RedisLike) {
  const get = async (id: string): Promise<AgentRecord | null> => {
    const raw = await redis.cmd(["GET", AGENT(id)]);
    return typeof raw === "string" ? (JSON.parse(raw) as AgentRecord) : null;
  };
  return {
    get,
    async save(a: AgentRecord) {
      await redis.cmd(["SET", AGENT(a.id), JSON.stringify(a)]);
    },
    /** Registers a new agent; false when that id or wallet is already registered. */
    async create(a: AgentRecord) {
      const ok = await redis.cmd(["SET", AGENT(a.id), JSON.stringify(a), "NX"]);
      if (ok !== "OK") return false;
      const claimed = await redis.cmd(["SET", ACCOUNT(a.account), a.id, "NX"]);
      if (claimed !== "OK") {
        await redis.cmd(["DEL", AGENT(a.id)]);
        return false;
      }
      await redis.cmd(["SADD", OWNER(a.owner), a.id]);
      return true;
    },
    async ofOwner(owner: Address): Promise<AgentRecord[]> {
      const ids = ((await redis.cmd(["SMEMBERS", OWNER(owner)])) as string[] | null) ?? [];
      const out = await Promise.all(ids.map(get));
      return out.filter((a): a is AgentRecord => !!a).sort((x, y) => x.createdAt - y.createdAt);
    },
    async byAccount(account: Address): Promise<AgentRecord | null> {
      const id = await redis.cmd(["GET", ACCOUNT(account)]);
      return typeof id === "string" ? get(id) : null;
    },
    async schedule(id: string, at: number) {
      await redis.cmd(["ZADD", DUE, at, id]);
    },
    async unschedule(id: string) {
      await redis.cmd(["ZREM", DUE, id]);
    },
    async due(now: number, limit: number): Promise<string[]> {
      return ((await redis.cmd(["ZRANGEBYSCORE", DUE, "-inf", now, "LIMIT", 0, limit])) as string[] | null) ?? [];
    },
    async addMove(id: string, m: Move) {
      await redis.cmd(["LPUSH", MOVES(id), JSON.stringify(m)]);
      await redis.cmd(["LTRIM", MOVES(id), 0, 199]);
    },
    /** What the agent chose to remember, newest first. */
    async addNote(id: string, text: string) {
      await redis.cmd(["LPUSH", NOTES(id), JSON.stringify({ at: Date.now(), text })]);
      await redis.cmd(["LTRIM", NOTES(id), 0, NOTES_KEPT - 1]);
    },
    async notes(id: string, n = NOTES_SHOWN): Promise<{ at: number; text: string }[]> {
      const raw = (await redis.cmd(["LRANGE", NOTES(id), 0, n - 1])) as string[] | null;
      return (raw ?? []).map((r) => JSON.parse(r));
    },
    async moves(id: string, n = 20): Promise<Move[]> {
      const raw = ((await redis.cmd(["LRANGE", MOVES(id), 0, n - 1])) as string[] | null) ?? [];
      return raw.map((r) => JSON.parse(r) as Move);
    },
    async positions(id: string): Promise<Position[]> {
      const h = hashToObject(await redis.cmd(["HGETALL", POSITIONS(id)]));
      return Object.values(h).map((v) => JSON.parse(v) as Position);
    },
    async setPosition(id: string, p: Position) {
      await redis.cmd(["HSET", POSITIONS(id), getAddress(p.token).toLowerCase(), JSON.stringify(p)]);
    },
    async removePosition(id: string, token: Address) {
      await redis.cmd(["HDEL", POSITIONS(id), token.toLowerCase()]);
    },
    /** A short lock so two runner calls never run the same agents at once. */
    async lock(name: string, seconds: number) {
      return (await redis.cmd(["SET", `nomad:lock:${name}`, String(Date.now()), "NX", "EX", seconds])) === "OK";
    },
    async unlock(name: string) {
      await redis.cmd(["DEL", `nomad:lock:${name}`]);
    },
    async cacheGet<T>(key: string): Promise<T | null> {
      const raw = await redis.cmd(["GET", `nomad:cache:${key}`]);
      return typeof raw === "string" ? (JSON.parse(raw) as T) : null;
    },
    async cacheSet(key: string, value: unknown, seconds: number) {
      await redis.cmd(["SET", `nomad:cache:${key}`, JSON.stringify(value), "EX", seconds]);
    }
  };
}

export type AgentStore = ReturnType<typeof agentStore>;
