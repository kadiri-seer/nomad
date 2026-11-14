import { redisFromEnv } from "./redis";
import { loadSuggestions } from "./rounds";
import { SuggestionStore } from "./suggest";

export function suggestionStore(env: Record<string, string | undefined> = process.env): SuggestionStore | null {
  const redis = redisFromEnv(env);
  const salt = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  return redis && salt ? new SuggestionStore(redis, salt) : null;
}

export { loadSuggestions };
