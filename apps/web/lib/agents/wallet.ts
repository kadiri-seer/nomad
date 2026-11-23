/**
 * Agent wallets: a Modular Account V2 per agent, owned by its creator's Google wallet, at a salt of its own (the
 * creator's main Nomad account is salt 0). Used in the browser (to create and withdraw) and on the server (to check a
 * registration and to send the runner's trades with its session key).
 */
import { createClient, http, toFunctionSelector, type Address, type Chain, type Client, type Hex, type Transport } from "viem";
import { toAccount } from "viem/accounts";
import { PermissionBuilder, PermissionType, deferralActions, encodeDeferredActionWithSignature } from "@alchemy/smart-accounts";
import type { SmartAccount } from "viem/account-abstraction";
import { SESSION_DAYS } from "./shared";
import { PUBLIC_RPC, STOA_ROUTER } from "../accounts/chain";
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

/** What the runner's key may do on an agent wallet: approve a token, and swap on Stoa's router. Nothing else. */
export const SESSION_FUNCTIONS = {
  approve: toFunctionSelector("approve(address,uint256)"),
  stoaSwap: toFunctionSelector("swap((address,address,address,(address,bool),(address,bool),uint256,uint256,address,uint256,address))")
};

/**
 * The creator's grant of a session key to Nomad's runner on a new agent wallet: a signed deferred action that installs
 * the key with the runner's first operation. The key can only approve tokens and swap on Stoa's router, until the
 * deadline: it cannot transfer tokens or ETH, call anything else, or change the wallet (its owner, modules or code).
 * Checked against Robinhood Chain's real contracts: approve-and-swap from the runner's key is accepted; a transfer, a
 * swap call to any other contract, an ETH transfer and an upgrade are refused; any other key is refused.
 */
export async function grantSession(account: SmartAccount, sessionAddress: Address, nowSeconds = Math.floor(Date.now() / 1000)) {
  const client = createClient({ account, chain: robinhood, transport: http(PUBLIC_RPC) }) as unknown as Client<Transport, Chain, SmartAccount>;
  const { entityId, nonce } = await deferralActions(client).getEntityIdAndNonce({ isGlobalValidation: false });
  const deadline = nowSeconds + SESSION_DAYS * 86_400;
  const { typedData, fullPreSignatureDeferredActionPayload } = await new PermissionBuilder({ client, key: { publicKey: sessionAddress, type: "secp256k1" }, entityId, nonce, deadline })
    .addPermissions({
      permissions: [
        { type: PermissionType.FUNCTIONS_ON_ALL_CONTRACTS, data: { functions: [SESSION_FUNCTIONS.approve] } },
        { type: PermissionType.FUNCTIONS_ON_CONTRACT, data: { address: STOA_ROUTER, functions: [SESSION_FUNCTIONS.stoaSwap] } }
      ]
    })
    .compileDeferred();
  const sig = await account.signTypedData(typedData);
  return { deferredAction: encodeDeferredActionWithSignature({ fullPreSignatureDeferredActionPayload, sig }), entityId, deadline };
}
