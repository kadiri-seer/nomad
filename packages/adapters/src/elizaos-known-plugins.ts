/**
 * ElizaOS plugins Nomad knows something about. Hints only: Nomad never adds,
 * installs or configures a plugin for you.
 */
export interface KnownElizaosPlugin {
  name: string;
  /** Setting names the plugin reads. */
  settingNames: string[];
  /** Settings that hold or point at key material. */
  sensitive: string[];
  /** Settings that limit what the agent may do with money. */
  safetyLimits: string[];
  /** The closest equivalent on platforms that use MCP servers. */
  equivalentMcp?: { local: string; hosted: string };
  note: string;
}

export const KNOWN_ELIZAOS_PLUGINS: KnownElizaosPlugin[] = [
  {
    name: "@priors/plugin-elizaos",
    settingNames: ["PRIORS_KEY_FILE", "PRIORS_KEY", "PRIORS_AGENT_ID", "PRIORS_OWNER_ENTITY_IDS", "PRIORS_PAY_HOSTS", "PRIORS_MAX_PRICE_USD", "PRIORS_MAX_SPEND_DAY_USD", "PRIORS_MAX_BORROW_DAY_USD", "PRIORS_STATE_DIR", "PRIORS_AUTO_BORROW_USD"],
    sensitive: ["PRIORS_KEY_FILE", "PRIORS_KEY"],
    safetyLimits: ["PRIORS_OWNER_ENTITY_IDS", "PRIORS_PAY_HOSTS", "PRIORS_MAX_PRICE_USD", "PRIORS_MAX_SPEND_DAY_USD", "PRIORS_MAX_BORROW_DAY_USD", "PRIORS_AUTO_BORROW_USD"],
    equivalentMcp: { local: "priors-wallet (@priors/mcp)", hosted: "https://mcp.priors.trade/mcp" },
    note: "Priors says the plugin runs @priors/mcp in process and reads the hosted read-only server."
  }
];

export function knownElizaosPlugin(name: string): KnownElizaosPlugin | undefined {
  return KNOWN_ELIZAOS_PLUGINS.find((p) => p.name === name);
}

/** The hint shown on other platforms for an ElizaOS plugin. */
export function elizaosPluginHint(name: string): string {
  const k = knownElizaosPlugin(name);
  if (k?.equivalentMcp) {
    return `On this platform, use the local MCP server ${k.equivalentMcp.local} and/or the hosted server ${k.equivalentMcp.hosted}. Nomad does not add them for you (the key stays with you).`;
  }
  return "Reinstall or replace it on this platform. Nomad never installs plugins.";
}
