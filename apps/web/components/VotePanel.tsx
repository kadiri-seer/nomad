"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatAmount, percent, voteMessage, type RoundOption } from "@/lib/vote/core";
import { REPO_URL } from "@/components/SiteFooter";
import { X_HANDLE, X_URL } from "@/components/Social";

export const WEBSITE_VOTE_URL = "https://nomad-iota-six.vercel.app/vote";
const PROPOSAL_URL = `${REPO_URL}/issues/new?template=integration-proposal.yml`;

type Results = { final: boolean; totals: Record<string, string>; voters: Record<string, number>; totalWeight: string; voterCount: number; winner: string | null };
type PublicRound = {
  id: number;
  title: string;
  opensAt: string;
  closesAt: string;
  status: "upcoming" | "open" | "closed";
  token: { address: string; symbol: string; decimals: number };
  snapshot: { takenAt: string; source: string; block: number | null; holders: number; totalWeight: string };
  options: RoundOption[];
  roundIssue: number | null;
  results: Results | null;
};
type Wallet = { address: string; excluded: boolean; weight: string; weightText: string; vote: { choice: string; votedAt: string } | null };
type PastRound = { id: number; title: string; closesAt: string; status: string; winner: RoundOption | null; voterCount: number | null; roundIssue: number | null };

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, fn: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, fn: (...args: unknown[]) => void) => void;
};

function provider(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) as Eip1193 | null;
}

function utf8Hex(text: string): string {
  return "0x" + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
}

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function timeLeft(to: string, now: number): string {
  let ms = Date.parse(to) - now;
  if (ms <= 0) return "now";
  const d = Math.floor(ms / 86_400_000);
  ms -= d * 86_400_000;
  const h = Math.floor(ms / 3_600_000);
  ms -= h * 3_600_000;
  const m = Math.max(1, Math.floor(ms / 60_000));
  if (d > 0) return `${d} day${d === 1 ? "" : "s"} ${h} hour${h === 1 ? "" : "s"}`;
  if (h > 0) return `${h} hour${h === 1 ? "" : "s"} ${m} min`;
  return `${m} min`;
}

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function getJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new Error("not-json");
  return { ok: res.ok, status: res.status, body: (await res.json()) as T };
}

export function VotePanel() {
  const [state, setState] = useState<"loading" | "ready" | "offsite" | "error">("loading");
  const [round, setRound] = useState<PublicRound | null>(null);
  const [storage, setStorage] = useState(true);
  const [past, setPast] = useState<PastRound[]>([]);
  const [account, setAccount] = useState<string | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "bad" | "info"; text: string } | null>(null);
  const [noWallet, setNoWallet] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  const loadRound = useCallback(async () => {
    try {
      const r = await getJson<{ round: PublicRound | null; storage?: boolean; error?: string }>("/api/vote");
      if (!r.ok) {
        setState("error");
        return;
      }
      setRound(r.body.round);
      setStorage(r.body.storage !== false);
      setState("ready");
    } catch {
      setState("offsite");
    }
  }, []);

  const loadWallet = useCallback(async (address: string, roundId: number) => {
    try {
      const r = await getJson<Wallet & { error?: string }>(`/api/vote/wallet?round=${roundId}&address=${address}`);
      if (r.ok) setWallet(r.body);
    } catch {
      /* the round panel already explains when the API is unreachable */
    }
  }, []);

  useEffect(() => {
    loadRound();
    getJson<{ rounds: PastRound[] }>("/api/vote/rounds")
      .then((r) => r.ok && setPast(r.body.rounds))
      .catch(() => undefined);
    const t = setInterval(() => setNow(Date.now()), 30_000);
    const refresh = setInterval(loadRound, 60_000);
    return () => {
      clearInterval(t);
      clearInterval(refresh);
    };
  }, [loadRound]);

  useEffect(() => {
    if (account && round) loadWallet(account, round.id);
  }, [account, round, loadWallet]);

  useEffect(() => {
    const eth = provider();
    if (!eth?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const list = args[0] as string[] | undefined;
      setAccount(list && list[0] ? list[0].toLowerCase() : null);
      setWallet(null);
      setChoice(null);
      setNotice(null);
    };
    eth.on("accountsChanged", onAccounts);
    return () => eth.removeListener?.("accountsChanged", onAccounts);
  }, []);

  async function connect() {
    setNotice(null);
    const eth = provider();
    if (!eth) {
      setNoWallet(true);
      return;
    }
    try {
      const list = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (list?.[0]) setAccount(list[0].toLowerCase());
    } catch (e) {
      const code = (e as { code?: number }).code;
      setNotice({ kind: "bad", text: code === 4001 ? "You cancelled the connection." : "Your wallet did not connect. Try again from your wallet app's browser." });
    }
  }

  async function castVote() {
    const eth = provider();
    if (!eth || !account || !round || !choice) return;
    const option = round.options.find((o) => o.id === choice);
    if (!option) return;
    setBusy(true);
    setNotice(null);
    try {
      const message = voteMessage(round, option, account);
      const signature = (await eth.request({ method: "personal_sign", params: [utf8Hex(message), account] })) as string;
      const r = await getJson<{ ok?: boolean; error?: string }>("/api/vote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ round: round.id, choice, address: account, signature })
      });
      if (r.ok) {
        setNotice({ kind: "ok", text: `Your vote for ${option.label} is in.` });
        await Promise.all([loadRound(), loadWallet(account, round.id)]);
      } else {
        setNotice({ kind: "bad", text: r.body.error ?? "Your vote was not saved." });
        await loadWallet(account, round.id);
      }
    } catch (e) {
      const code = (e as { code?: number }).code;
      setNotice({ kind: "bad", text: code === 4001 ? "You cancelled the signature. Nothing was sent." : "Your vote was not saved. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(WEBSITE_VOTE_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* copying is a convenience */
    }
  }

  const totals = useMemo(() => {
    const r = round?.results;
    const total = r ? BigInt(r.totalWeight) : 0n;
    return round?.options.map((o) => {
      const amount = r ? BigInt(r.totals[o.id] ?? "0") : 0n;
      return { option: o, amount, pct: percent(amount, total), voters: r?.voters[o.id] ?? 0 };
    });
  }, [round]);

  if (state === "loading") return <p className="muted">Loading the vote…</p>;

  if (state === "offsite") {
    return (
      <div className="panel panel-body vote-empty">
        <p>Voting runs on the Nomad website, not in the local app.</p>
        <p>
          <a className="btn" href={WEBSITE_VOTE_URL}>
            Open the vote page
          </a>
        </p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="panel panel-body vote-empty">
        <p>The vote could not be loaded right now. Refresh the page in a minute.</p>
      </div>
    );
  }

  const pastRounds = past.filter((p) => p.id !== round?.id);

  return (
    <div className="vote">
      {!round || (round.status === "closed" && round.results?.final) ? (
        <div className="panel panel-body vote-empty">
          <p>
            <strong>No vote is open right now.</strong> Rounds open every two weeks. Suggest an app for the next ballot with the <a href={PROPOSAL_URL}>suggestion form</a> or by replying to the pinned post on <a href={X_URL}>{X_HANDLE}</a>.
          </p>
        </div>
      ) : null}

      {round ? (
        <section className="panel vote-round" aria-labelledby="round-title">
          <div className="panel-head">
            <div>
              <p className="label">Round {round.id}</p>
              <h2 id="round-title" className="vote-title">
                {round.title}
              </h2>
            </div>
            <span className={`badge ${round.status === "open" ? "ok" : round.status === "upcoming" ? "info" : "warn"}`}>{round.status === "open" ? "Open" : round.status === "upcoming" ? "Not open yet" : round.results?.final ? "Final" : "Closed, counting"}</span>
          </div>
          <div className="panel-body">
            <p className="muted vote-when">
              {round.status === "open" && <>Closes in {timeLeft(round.closesAt, now)} ({when(round.closesAt)}).</>}
              {round.status === "upcoming" && <>Opens {when(round.opensAt)}.</>}
              {round.status === "closed" && <>Closed {when(round.closesAt)}.</>} One {round.token.symbol} is one vote, counted from balances when the round opened.
            </p>

            {round.status === "open" && (
              <div className="vote-wallet">
                {!account ? (
                  <>
                    <button type="button" className="btn" onClick={connect}>
                      Connect wallet
                    </button>
                    {noWallet && (
                      <div className="vote-help">
                        <p>No wallet found in this browser. Open this page inside your wallet app&apos;s browser (Robinhood Wallet, MetaMask, Rabby and others have one), or use a browser with a wallet extension.</p>
                        <button type="button" className="btn btn-quiet btn-sm" onClick={copyLink}>
                          {copied ? "Link copied" : "Copy this page's link"}
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="vote-account">
                    <span className="mono">{short(account)}</span>
                    {wallet ? (
                      wallet.excluded ? (
                        <span>Team and reward wallets do not vote.</span>
                      ) : wallet.weight === "0" ? (
                        <span>This wallet held no {round.token.symbol} when the round opened, so it cannot vote in this round.</span>
                      ) : (
                        <span>
                          Voting power: <strong>{wallet.weightText}</strong> {round.token.symbol}
                        </span>
                      )
                    ) : (
                      <span className="muted">Checking your balance…</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {!storage && round.status === "open" && <p className="vote-notice bad">Voting storage is not connected yet, so votes cannot be saved.</p>}

            <fieldset className="vote-options" disabled={busy}>
              <legend className="sr-only">Ballot</legend>
              {totals?.map(({ option, amount, pct, voters }) => {
                const canPick = round.status === "open" && !!wallet && !wallet.excluded && wallet.weight !== "0" && !wallet.vote && storage;
                const mine = wallet?.vote?.choice === option.id;
                const won = round.results?.final && round.results.winner === option.id;
                return (
                  <label key={option.id} className={`vote-option${choice === option.id ? " picked" : ""}${won ? " won" : ""}`}>
                    <span className="vote-option-row">
                      {canPick && <input type="radio" name="choice" value={option.id} checked={choice === option.id} onChange={() => setChoice(option.id)} />}
                      <span className="vote-option-name">
                        {option.label}{" "}
                        <a href={`${REPO_URL}/issues/${option.issue}`} className="muted" onClick={(e) => e.stopPropagation()}>
                          #{option.issue}
                        </a>
                      </span>
                      {mine && <span className="badge info">Your vote</span>}
                      {won && <span className="badge ok">Winner</span>}
                      <span className="vote-pct">{round.results ? `${pct}%` : ""}</span>
                    </span>
                    {round.results && (
                      <>
                        <span className="vote-bar" aria-hidden="true">
                          <span style={{ width: `${pct}%` }} />
                        </span>
                        <span className="vote-meta muted">
                          {formatAmount(amount, round.token.decimals, 0)} {round.token.symbol} from {voters} wallet{voters === 1 ? "" : "s"}
                        </span>
                      </>
                    )}
                  </label>
                );
              })}
            </fieldset>

            {round.status === "open" && account && wallet && !wallet.vote && !wallet.excluded && wallet.weight !== "0" && storage && (
              <div className="vote-actions">
                <button type="button" className="btn btn-lime" onClick={castVote} disabled={!choice || busy}>
                  {busy ? "Waiting for your wallet…" : "Sign and vote"}
                </button>
                <span className="muted">Free. Your wallet signs a message; no transaction is sent and no tokens leave your wallet. One vote per wallet, and it cannot be changed.</span>
              </div>
            )}

            {notice && <p className={`vote-notice ${notice.kind}`}>{notice.text}</p>}

            <p className="muted vote-proof">
              {round.results ? `${round.results.voterCount} wallet${round.results.voterCount === 1 ? "" : "s"} voted. ` : ""}
              Check it yourself: <a href={`/api/vote/votes?round=${round.id}`}>every signed vote</a> · <a href={`${REPO_URL}/blob/main/governance/rounds/round-${round.id}-holders.json`}>balances when the round opened</a>
              {round.roundIssue ? (
                <>
                  {" "}
                  · <a href={`${REPO_URL}/issues/${round.roundIssue}`}>round page</a>
                </>
              ) : null}
            </p>
          </div>
        </section>
      ) : null}

      {pastRounds.length > 0 && (
        <section className="vote-past">
          <h2>Past rounds</h2>
          <ul>
            {pastRounds.map((p) => (
              <li key={p.id}>
                <span>Round {p.id}</span>
                <span>{p.winner ? <>Winner: {p.winner.label}</> : p.status === "closed" ? "No winner" : "In progress"}</span>
                <span className="muted">{p.voterCount !== null ? `${p.voterCount} wallets` : ""}</span>
                {p.roundIssue ? <a href={`${REPO_URL}/issues/${p.roundIssue}`}>Details</a> : <span />}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
