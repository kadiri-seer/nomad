/**
 * Sending an agent's operations from the server: the agent's wallet driven by the runner's session key (installed by
 * the creator's signed grant on its first operation), through Alchemy's bundler, with gas from NomadPaymaster charged
 * to the creator's credits by the same sponsor service the account pages use.
 */
import { createPublicClient, custom, getAddress, http, type Address, type Hex } from "viem";
import { createBundlerClient, createPaymasterClient } from "viem/account-abstraction";
import { toModularAccountV2 } from "@alchemy/smart-accounts";
import { PUBLIC_RPC } from "../accounts/chain";
import { robinhood } from "../accounts/client";
import type { AgentRecord } from "../agents/shared";
import { addressOnlyOwner } from "../agents/wallet";
import { sessionSigner } from "./runner-keys";
import { sponsor, stubData, type SponsorDeps } from "./sponsor";

export const serverClient = () => createPublicClient({ chain: robinhood, transport: http(PUBLIC_RPC) });

export type Call = { to: Address; data: Hex; value?: bigint };

/** Checks that `account` really is the agent wallet of `signer` at `salt`, and returns how to deploy it. */
export async function expectedAgentWallet(signer: Address, salt: bigint) {
  const acct = await toModularAccountV2({ client: serverClient(), owner: addressOnlyOwner(signer), salt });
  return { address: getAddress(acct.address), factoryArgs: await acct.getFactoryArgs() };
}

/** The creator's main Nomad account for this signer (salt 0). */
export async function mainAccountOf(signer: Address) {
  return (await expectedAgentWallet(signer, 0n)).address;
}

export async function agentSender(agent: AgentRecord, secret: Hex, sponsorDeps: SponsorDeps, bundlerUrl: string) {
  const client = serverClient();
  const { address, factoryArgs } = await expectedAgentWallet(agent.signer, BigInt(agent.salt));
  if (address.toLowerCase() !== agent.account.toLowerCase()) throw new Error("The agent wallet does not match its owner.");
  const code = await client.getCode({ address });
  const deployed = !!code && code !== "0x";
  const account = await toModularAccountV2({
    client,
    owner: sessionSigner(secret, agent.account),
    accountAddress: agent.account,
    signerEntity: { entityId: agent.sessionEntityId, isGlobalValidation: false },
    deferredAction: agent.deferredAction,
    ...(deployed || !factoryArgs.factory ? {} : { factory: factoryArgs.factory, factoryData: factoryArgs.factoryData })
  });
  const paymaster = createPaymasterClient({
    transport: custom({
      async request({ method, params }) {
        const p = (params ?? []) as unknown[];
        if (method === "pm_getPaymasterStubData") return stubData(sponsorDeps, p);
        if (method === "pm_getPaymasterData") {
          const { kind: _k, paidBy: _p, ...data } = await sponsor(sponsorDeps, p);
          return data;
        }
        throw new Error(`${method} is not supported`);
      }
    })
  });
  const bundler = createBundlerClient({
    account,
    client,
    chain: robinhood,
    transport: http(bundlerUrl),
    paymaster,
    userOperation: {
      async estimateFeesPerGas() {
        const block = await client.getBlock();
        const base = block.baseFeePerGas ?? (await client.getGasPrice());
        return { maxFeePerGas: base * 2n, maxPriorityFeePerGas: 0n };
      }
    }
  });
  return {
    async send(calls: Call[]): Promise<Hex> {
      const hash = await bundler.sendUserOperation({ calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })) });
      const r = await bundler.waitForUserOperationReceipt({ hash, timeout: 90_000 });
      if (!r.success) throw new Error("The operation reverted on-chain.");
      return r.receipt.transactionHash;
    }
  };
}
