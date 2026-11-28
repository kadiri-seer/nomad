/**
 * Whether a successful transaction was the work of a wallet: sent by it, sent as its smart account's operation, or a
 * transfer of its tokens it signed for someone else to send (an EIP-3009 TransferWithAuthorization, the way a payer
 * with no ETH pays a Stoa agent service; the token logs the transfer out of the wallet).
 */
import { decodeEventLog, parseAbi, type Address, type Hex } from "viem";

/** A log as receipts give it. */
export type ReceiptLog = { address: Address; data: Hex; topics: readonly Hex[] };

const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const USEROP = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
export const ENTRY_POINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const lc = (a: string) => a.toLowerCase();

export function madeBy(r: { status: string; from: Address; logs: ReceiptLog[] }, wallet: Address): boolean {
  if (r.status !== "success") return false;
  if (lc(r.from) === lc(wallet)) return true;
  let sentFrom = false;
  let asAccount = false;
  for (const l of r.logs) {
    try {
      if (lc(l.address) === ENTRY_POINT) {
        const ev = decodeEventLog({ abi: USEROP, data: l.data, topics: l.topics as never });
        if (ev.eventName === "UserOperationEvent" && lc(ev.args.sender) === lc(wallet) && ev.args.success) asAccount = true;
        continue;
      }
    } catch {
      /* another event */
    }
    try {
      const ev = decodeEventLog({ abi: TRANSFER, data: l.data, topics: l.topics as never });
      if (ev.eventName === "Transfer" && lc(ev.args.from) === lc(wallet)) sentFrom = true;
    } catch {
      /* another event */
    }
  }
  // Tokens leave a wallet only with its own signature: as the sender, as its account's operation, or through an
  // authorization or approval it signed. A transfer out of it is its own doing.
  return asAccount || sentFrom;
}

/** A Stoa agent service, as Stoa's public list shows it: its id, name, the wallet it is paid to, and its price. */
export type StoaService = { id: string; name: string; wallet: Address; price: string };

/**
 * Whether a transaction paid a Stoa agent service from `wallet`, gaslessly: a USDG transfer from the wallet to a
 * listed service's wallet for at least its price, sent by someone else (EIP-3009), after `sinceMs`.
 */
export function stoaPaymentChecks(
  r: { status: string; from: Address; logs: ReceiptLog[]; time: number },
  wallet: Address,
  usdg: Address,
  services: StoaService[],
  sinceMs: number
): { name: string; ok: boolean; detail?: string }[] {
  if (r.status !== "success") return [{ name: "Paid a Stoa agent service", ok: false, detail: "That transaction failed on chain." }];
  const paid: { to: string; value: bigint }[] = [];
  for (const l of r.logs) {
    if (lc(l.address) !== lc(usdg)) continue;
    try {
      const ev = decodeEventLog({ abi: TRANSFER, data: l.data, topics: l.topics as never });
      if (ev.eventName === "Transfer" && lc(ev.args.from) === lc(wallet)) paid.push({ to: lc(ev.args.to), value: ev.args.value });
    } catch {
      /* another event */
    }
  }
  const units = (price: string) => BigInt(Math.round(Number(price) * 1e6));
  const service = services.find((s) => paid.some((p) => p.to === lc(s.wallet) && p.value >= units(s.price)));
  const asAccount = r.logs.some((l) => {
    if (lc(l.address) !== ENTRY_POINT) return false;
    try {
      const ev = decodeEventLog({ abi: USEROP, data: l.data, topics: l.topics as never });
      return ev.eventName === "UserOperationEvent" && lc(ev.args.sender) === lc(wallet);
    } catch {
      return false;
    }
  });
  return [
    service
      ? { name: "Paid a Stoa agent service", ok: true, detail: `${service.name}, from your linked wallet` }
      : { name: "Paid a Stoa agent service", ok: false, detail: paid.length ? "The USDG did not go to a Stoa service's wallet for its price." : "No USDG left your linked wallet in that transaction." },
    lc(r.from) !== lc(wallet) && !asAccount
      ? { name: "Gasless", ok: true, detail: "Sent by someone else, so your wallet paid no gas" }
      : { name: "Gasless", ok: false, detail: "Your wallet sent this transaction itself. Sign a TransferWithAuthorization and let another wallet send it." },
    r.time >= sinceMs ? { name: "Paid after the bounty opened", ok: true } : { name: "Paid after the bounty opened", ok: false, detail: "This payment was made before the bounty opened." }
  ];
}
