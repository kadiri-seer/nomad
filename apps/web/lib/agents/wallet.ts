/**
 * Agent wallets: a Modular Account V2 per agent, owned by its creator's Google wallet, at a salt of its own (the
 * creator's main Nomad account is salt 0). Used in the browser (to create and withdraw) and on the server (to check a
 * registration and to send the runner's trades with its session key).
 */
import { createClient, http, type Address, type Chain, type Client, type Hex, type Transport } from "viem";
import { toAccount } from "viem/accounts";
import { PermissionBuilder, PermissionType, deferralActions, encodeDeferredActionWithSignature } from "@alchemy/smart-accounts";
import type { SmartAccount } from "viem/account-abstraction";
import { SESSION_DAYS } from "./shared";
import { PUBLIC_RPC } from "../accounts/chain";
import { robinhood } from "../accounts/client";

/** A stand-in owner that knows only its address: enough to work out an account's address and how to deploy it. */
export function addressOnlyOwner(address: Address) {
  const no = async (): Promise<Hex> => {
    throw new Error("This owner cannot sign here.");
  };
  return toAccount({ address, signMessage: no, signTypedData: no, signTransaction: no });
}

/** A fresh salt for a new agent wallet (never 0, which is the main account). */
export const newSalt = () => BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)) + 1n;

/**
 * The creator's grant of a session key to Nomad's runner on a new agent wallet: a signed deferred action that installs
 * the key (full use of this wallet only, until the deadline) with the runner's first operation. Nothing is sent here.
 * Checked against Robinhood Chain's real contracts: the runner's key deploys the wallet, installs itself and acts in
 * one operation; any other key is refused.
 */
export async function grantSession(account: SmartAccount, sessionAddress: Address, nowSeconds = Math.floor(Date.now() / 1000)) {
  const client = createClient({ account, chain: robinhood, transport: http(PUBLIC_RPC) }) as unknown as Client<Transport, Chain, SmartAccount>;
  const { entityId, nonce } = await deferralActions(client).getEntityIdAndNonce({ isGlobalValidation: true });
  const deadline = nowSeconds + SESSION_DAYS * 86_400;
  const { typedData, fullPreSignatureDeferredActionPayload } = await new PermissionBuilder({ client, key: { publicKey: sessionAddress, type: "secp256k1" }, entityId, nonce, deadline })
    .addPermission({ permission: { type: PermissionType.ROOT } })
    .compileDeferred();
  const sig = await account.signTypedData(typedData);
  return { deferredAction: encodeDeferredActionWithSignature({ fullPreSignatureDeferredActionPayload, sig }), entityId, deadline };
}
