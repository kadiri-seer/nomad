/** $NOMAD token and treasury details, shared by the footer and the token page. */

export const TOKEN_TICKER = "$NOMAD";
export const TOKEN_CHAIN = "Robinhood Chain";
export const TOKEN_CA = "0x14c0a77e792f6c9818888630e95c50cf3b48c979";

/** Nomad's treasury, which pays builder rewards: one wallet with one key, not a multisig. */
export const REWARD_SAFE = "0xe4862B7605f0CD66796F5d1A9cC936462642b515";

export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const TOKEN_EXPLORER_URL = `${EXPLORER}/token/${TOKEN_CA}`;
export const TOKEN_HOLDERS_URL = `${EXPLORER}/token/${TOKEN_CA}?tab=holders`;
export const TOKEN_CHART_URL = `https://dexscreener.com/robinhood/${TOKEN_CA}`;
export const REWARD_SAFE_URL = `${EXPLORER}/address/${REWARD_SAFE}`;

/**
 * Tokens sent to Nomad's wallets unasked (spam airdrops), by address, lower case. They are left out of balances,
 * totals and activity on the site; they stay on the explorer. Add one here when it turns up.
 */
export const SPAM_TOKENS = new Set<string>([
  "0x71fa6238a4f61673b0bf81f2f64f54ea651c59b7" // ROBINCAT, airdropped to Nomad AI's Rushr wallet; Rushr blocks it
]);
export const isSpamToken = (address: unknown) => typeof address === "string" && SPAM_TOKENS.has(address.toLowerCase());
