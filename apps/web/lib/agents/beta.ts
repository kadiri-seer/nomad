/**
 * The closed beta for creating agents: while CREATE_BETA_ONLY is true and minting is open on the agents contract, only
 * beta testers' accounts can create agents from the site. Who they are is kept on the server (lib/server/beta.ts) and
 * told only to the account that asks, by signature.
 */
export const CREATE_BETA_ONLY = true;

/** What an account signs (silently, with its sign-in wallet) to ask whether it is a beta tester. */
export const betaMessage = (at: number) => `Nomad beta: check at ${at}`;
