import type { Address } from "viem";
import type { accountClient, Call, ownerFromProvider } from "@/lib/accounts/client";

export type Owner = ReturnType<typeof ownerFromProvider>;
export type Client = Awaited<ReturnType<typeof accountClient>> & { owner: Owner; signer: Address };
export type Confirm = {
  /** The wallet that sends this (an agent's wallet for a withdrawal); the person's account by default. */
  via?: Awaited<ReturnType<typeof accountClient>>;
  title: string;
  amount: string;
  amountNote: string;
  rows: [string, string][];
  note?: string;
  build: () => Promise<Call[]>;
  after?: (txHash: string) => Promise<string | void>;
  done: { title: string; body: string };
};

