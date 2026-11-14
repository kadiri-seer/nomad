import { findRedisEnv, UpstashRedis } from "./redis";
import { loadSuggestions } from "./rounds";
import { SuggestionStore } from "./suggest";

export function suggestionStore(env: Record<string, string | undefined> = process.env): SuggestionStore | null {
  const found = findRedisEnv(env);
  return found ? new SuggestionStore(new UpstashRedis(found.url, found.token), found.token) : null;
}

export { loadSuggestions };
