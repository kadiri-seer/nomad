"use client";

/**
 * Taking money out of a Nomad account: Send (USDG, $NOMAD, ETH or any other token to any Robinhood Chain address),
 * and the other tokens in the account (from an agent's wallet, or sent in), each of which can be sold for USDG or sent.
 */
import { useEffect, useState } from "react";
import { formatUnits, getAddress, isAddress, parseUnits, type Address } from "viem";
import { NOMAD, TREASURY, USDG } from "@/lib/accounts/chain";
import { otherHoldings, publicClient, sellCalls, sendCalls, type Holding } from "@/lib/accounts/client";
import { Sheet } from "./Sheet";
import type { Confirm } from "./types";

const fmt = (h: Pick<Holding, "amount" | "decimals">) => {
  const n = Number(formatUnits(h.amount, h.decimals));
  return n >= 1000 ? Math.floor(n).toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 6 });
};

export function SendSheet({
  account,
  holdings,
  start,
  agentWallets,
  onClose,
  onConfirm
}: {
  account: Address;
  holdings: Holding[];
  start?: Holding["token"];
  agentWallets: Address[];
  onClose: () => void;
  onConfirm: (c: Confirm) => void;
}) {
  const [token, setToken] = useState<string>(String(start ?? holdings[0]?.token ?? USDG));
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [isContract, setIsContract] = useState(false);
  const h = holdings.find((x) => String(x.token) === token) ?? null;

  const value = (() => {
    try {
      return h && amount ? parseUnits(amount, h.decimals) : 0n;
    } catch {
      return 0n;
    }
  })();
  const clean = to.trim();
  const valid = isAddress(clean, { strict: false });
  const dest = valid ? (getAddress(clean) as Address) : null;
  const own = dest && dest.toLowerCase() === account.toLowerCase();
  const toAgent = dest && agentWallets.some((a) => a.toLowerCase() === dest.toLowerCase());
  const toTreasury = dest && dest.toLowerCase() === TREASURY.toLowerCase();
  const toToken = dest && [NOMAD, USDG].some((t) => t.toLowerCase() === dest.toLowerCase());

  useEffect(() => {
    setIsContract(false);
    if (!dest || toAgent) return;
    publicClient
      .getCode({ address: dest })
      .then((c) => setIsContract(!!c && c !== "0x"))
      .catch(() => undefined);
  }, [dest, toAgent]);

  const problem = !h
    ? "Nothing to send yet."
    : value <= 0n
      ? "Enter an amount."
      : value > h.amount
        ? `You have ${fmt(h)} ${h.symbol}.`
        : !clean
          ? "Paste the address to send to."
          : !dest
            ? "That is not a Robinhood Chain address."
            : own
              ? "That is this account's own address."
              : toToken
                ? "That is a token's contract, not a wallet. Tokens sent there are lost."
                : null;

  const go = () => {
    if (problem || !h || !dest) return;
    onConfirm({
      title: `Send ${h.symbol}`,
      amount: `-${fmt({ amount: value, decimals: h.decimals })} ${h.symbol}`,
      amountNote: "out of your Nomad account",
      rows: [
        ["To", dest],
        ["Network", "Robinhood Chain"],
        ["Network fee", "Included"]
      ],
      note: "A send can't be undone. Check every character of the address.",
      build: async () => sendCalls(h.token, dest, value),
      done: { title: "Sent", body: `${fmt({ amount: value, decimals: h.decimals })} ${h.symbol} was sent to ${dest.slice(0, 6)}...${dest.slice(-4)}.` }
    });
  };

  return (
    <Sheet title="Send" onClose={onClose}>
      <label className="acct-field">
        <span>What to send</span>
        <select value={token} onChange={(e) => setToken(e.target.value)}>
          {holdings.map((x) => (
            <option key={String(x.token)} value={String(x.token)}>
              {x.symbol} (you have {fmt(x)})
            </option>
          ))}
        </select>
      </label>
      <label className="acct-field">
        <span>Amount</span>
        <div className="acct-grid2">
          <input className="acct-input" value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, "").slice(0, 24))} />
          <button type="button" className="acct-secondary" onClick={() => h && setAmount(formatUnits(h.amount, h.decimals))} disabled={!h}>
            Max
          </button>
        </div>
      </label>
      <label className="acct-field">
        <span>To (a Robinhood Chain address)</span>
        <input value={to} placeholder="0x..." autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(e) => setTo(e.target.value.slice(0, 64))} />
      </label>
      {toTreasury && <p className="acct-warn">That is Nomad&apos;s treasury. To pay for agents, use Add credits instead: a send here is not counted as credits.</p>}
      {toAgent && <p className="acct-small">That is one of your agents&apos; wallets.</p>}
      {isContract && !toAgent && !toTreasury && <p className="acct-warn">That address is a contract. Send only if you know it can receive tokens on Robinhood Chain.</p>}
      <p className="acct-warn">Only send to an address on Robinhood Chain. Sending to an exchange or a wallet on another network can lose the funds.</p>
      <button type="button" className="acct-primary" disabled={!!problem} onClick={go}>
        {problem && value > 0n && clean ? problem : "Continue"}
      </button>
      {problem && !(value > 0n && clean) && <p className="acct-small">{problem}</p>}
    </Sheet>
  );
}

/** Tokens in the account other than $NOMAD and USDG, each with Sell for USDG and Send. Shown only when there are any. */
export function OtherTokens({ holdings, account, onSend, onConfirm }: { holdings: Holding[]; account: Address; onSend: (h: Holding) => void; onConfirm: (c: Confirm) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!holdings.length) return null;
  const sell = async (h: Holding) => {
    if (h.token === "eth") return;
    setBusy(h.token);
    setErr(null);
    try {
      const q = await sellCalls(h.token, h.amount, account);
      if (q.impactPct !== null && q.impactPct > 5) throw new Error(`Selling all ${h.symbol} now would move its price by ${q.impactPct.toFixed(1)}%. Try a smaller amount with Send, or later.`);
      onConfirm({
        title: `Sell ${h.symbol}`,
        amount: `+${(Number(q.amountOut) / 1e6).toFixed(2)} USDG`,
        amountNote: `for all your ${fmt(h)} ${h.symbol}`,
        rows: [["Swap through", "Stoa"], ["To", "Your account"], ["Network fee", "Included"]],
        note: "Prices move: the amount is checked again when it is sent, and it does not go through if the price moved more than 1%.",
        build: async () => (await sellCalls(h.token as Address, h.amount, account)).calls,
        done: { title: "Sold", body: `Your ${h.symbol} was sold for USDG.` }
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="acct-card" aria-labelledby="other-tokens">
      <h2 id="other-tokens" className="acct-h3">
        Other tokens
      </h2>
      {holdings.map((h) => (
        <div key={String(h.token)} className="acct-stack" style={{ gap: 8 }}>
          <div className="acct-between">
            <span>{h.symbol}</span>
            <strong>{fmt(h)}</strong>
          </div>
          <div className="acct-grid2">
            {h.token !== "eth" ? (
              <button type="button" className="acct-secondary" disabled={busy !== null} onClick={() => sell(h)}>
                {busy === h.token ? "Getting a price" : "Sell for USDG"}
              </button>
            ) : (
              <span />
            )}
            <button type="button" className="acct-secondary" onClick={() => onSend(h)}>
              Send
            </button>
          </div>
        </div>
      ))}
      {err && <p className="acct-error">{err}</p>}
      <p className="acct-small">Tokens from your agents, or sent to this account. Nomad has not checked tokens it did not buy: a token you do not know may be spam.</p>
    </section>
  );
}

export { otherHoldings };
