/**
 * Whether a successful transaction was the work of a wallet: sent by it, sent as its smart account's operation, or a
 * transfer of its tokens it signed for someone else to send (an EIP-3009 TransferWithAuthorization, the way a payer
 * with no ETH pays a Stoa agent service; the token logs the transfer out of the wallet).
 */
import { decodeEventLog, parseAbi, type Address, type Log } from "viem";

const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const USEROP = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
export const ENTRY_POINT = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const lc = (a: string) => a.toLowerCase();

export function madeBy(r: { status: string; from: Address; logs: Pick<Log, "address" | "data" | "topics">[] }, wallet: Address): boolean {
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
