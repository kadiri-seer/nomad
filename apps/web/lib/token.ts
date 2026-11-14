/** $NOMAD token and reward wallet details, shared by the footer and the token page. */

export const TOKEN_TICKER = "$NOMAD";
export const TOKEN_CHAIN = "Robinhood Chain";
export const TOKEN_CA = "0x14c0a77e792f6c9818888630e95c50cf3b48c979";

/** The Safe multisig that pays builder rewards. Two approvals are needed to send from it. */
export const REWARD_SAFE = "0xe4862B7605f0CD66796F5d1A9cC936462642b515";

export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const TOKEN_EXPLORER_URL = `${EXPLORER}/token/${TOKEN_CA}`;
export const TOKEN_HOLDERS_URL = `${EXPLORER}/token/${TOKEN_CA}?tab=holders`;
export const TOKEN_CHART_URL = `https://dexscreener.com/robinhood/${TOKEN_CA}`;
export const REWARD_SAFE_URL = `${EXPLORER}/address/${REWARD_SAFE}`;
export const SNAPSHOT_URL = "https://snapshot.box";
