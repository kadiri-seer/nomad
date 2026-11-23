"use client";

import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, erc20Abi, formatUnits, parseUnits, type Abi } from "viem";
import { addressUrl, fmt, txUrl } from "@/lib/agent";
import { AGENTS_ABI } from "@/lib/agents-contract";
import { AGENTS_CONTRACT, readAgents, tokenAmount, NOMAD_DECIMALS, type AgentsSummary, type MintedAgent } from "@/lib/economy";
import { TOKEN_CA } from "@/lib/token";
import { connect, getWallet, readContract, send, sha256File, waitFor, walletMessage, type Eip1193 } from "@/lib/wallet";
import { Badge, Notice, Skeleton, formatDate } from "./ui";

const ABI = AGENTS_ABI as unknown as Abi;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
type Status = { tone: "info" | "ok" | "bad" | "warn"; text: string; hash?: string } | null;
type Settings = { open: boolean; fee: bigint; platformBps: bigint };

/** Approves exactly `amount` of $NOMAD for the contract when the allowance is lower, and waits for it. */
async function approveIfNeeded(eth: Eip1193, account: string, contract: string, amount: bigint, say: (s: Status) => void) {
  if (amount === 0n) return;
  const allowance = await readContract<bigint>(eth, TOKEN_CA, erc20Abi as Abi, "allowance", [account, contract]);
  if (allowance >= amount) return;
  say({ tone: "info", text: `Step 1 of 2: approve ${tokenAmount(Number(formatUnits(amount, NOMAD_DECIMALS)))} for the agents contract in your wallet.` });
  const hash = await send(eth, account, { to: TOKEN_CA, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contract as `0x${string}`, amount] }) });
  say({ tone: "info", text: "Waiting for the approval to be confirmed…", hash });
  await waitFor(eth, hash);
}

function AgentCard({ a, account, contract, onDone }: { a: MintedAgent; account: string | null; contract: string; onDone: () => void }) {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const mine = account && a.creator.toLowerCase() === account.toLowerCase();

  async function getCopy() {
    const eth = getWallet();
    if (!eth || !account) return setStatus({ tone: "warn", text: "Connect your wallet first." });
    setBusy(true);
    try {
      const has = await readContract<boolean>(eth, contract, ABI, "hasCopy", [BigInt(a.id), account]);
      if (has) return setStatus({ tone: "ok", text: "You already have a copy of this agent." });
      const info = await readContract<{ price: bigint }>(eth, contract, ABI, "agent", [BigInt(a.id)]);
      await approveIfNeeded(eth, account, contract, info.price, setStatus);
      setStatus({ tone: "info", text: info.price > 0n ? "Step 2 of 2: confirm the copy in your wallet." : "Confirm in your wallet (free; only network gas)." });
      const hash = await send(eth, account, { to: contract, data: encodeFunctionData({ abi: ABI, functionName: "getCopy", args: [BigInt(a.id), info.price] }) });
      setStatus({ tone: "info", text: "Waiting for confirmation…", hash });
      await waitFor(eth, hash);
      setStatus({ tone: "ok", text: "Done: you have a copy. Download the package below and check its SHA-256 before importing it with Nomad.", hash });
      onDone();
    } catch (e) {
      setStatus({ tone: "bad", text: walletMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel agent-card">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <h3>{a.name}</h3>
        <span className="muted mono">#{a.id}</span>
      </div>
      <dl className="kv">
        <dt>Creator</dt>
        <dd>
          <a className="mono" href={addressUrl(a.creator)} target="_blank" rel="noopener noreferrer">
            {short(a.creator)}
          </a>
          {mine && (
            <>
              {" "}
              <Badge kind="info">You</Badge>
            </>
          )}
        </dd>
        <dt>Copy</dt>
        <dd>{a.price > 0 ? tokenAmount(a.price) : "Free"}</dd>
        <dt>Copies</dt>
        <dd>{a.copies}</dd>
        <dt>Minted</dt>
        <dd>
          <a href={txUrl(a.hash)} target="_blank" rel="noopener noreferrer">
            {formatDate(a.mintedAt)}
          </a>
        </dd>
      </dl>
      <div>
        <span className="label">Package SHA-256</span>
        <div className="agent-hash">{a.packageHash.slice(2)}</div>
      </div>
      <div className="token-ca-links">
        {a.uri ? (
          <a href={a.uri} target="_blank" rel="noopener noreferrer nofollow">
            Package link
          </a>
        ) : (
          <span className="muted">No package link</span>
        )}
        {!mine && (
          <button type="button" className="btn btn-sm" disabled={busy || !account} onClick={getCopy}>
            {a.price > 0 ? `Get a copy for ${fmt(a.price)} $NOMAD` : "Get a free copy"}
          </button>
        )}
      </div>
      {status && (
        <Notice tone={status.tone}>
          {status.text}
          {status.hash && (
            <>
              {" "}
              <a href={txUrl(status.hash)} target="_blank" rel="noopener noreferrer">
                Transaction
              </a>
            </>
          )}
        </Notice>
      )}
    </article>
  );
}

function MintForm({ account, contract, settings, onDone }: { account: string | null; contract: string; settings: Settings | null; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [name, setName] = useState("");
  const [uri, setUri] = useState("");
  const [price, setPrice] = useState("0");
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  async function pick(f: File | null) {
    setFile(f);
    setHash(null);
    if (!f) return;
    if (!name) setName(f.name.replace(/\.nomad$/i, "").slice(0, 64));
    try {
      setHash(await sha256File(f));
    } catch {
      setStatus({ tone: "bad", text: "That file could not be read." });
    }
  }

  async function mint() {
    const eth = getWallet();
    if (!eth || !account) return setStatus({ tone: "warn", text: "Connect your wallet first." });
    if (!hash || !file) return setStatus({ tone: "warn", text: "Choose the agent's .nomad file first." });
    const n = name.trim();
    if (!n || new TextEncoder().encode(n).length > 64) return setStatus({ tone: "warn", text: "Give the agent a name of up to 64 characters." });
    const link = uri.trim();
    if (link && !/^https:\/\/[^\s"<>]{1,240}$/.test(link)) return setStatus({ tone: "warn", text: "The package link must be an https:// address (up to 240 characters), or left empty." });
    let priceWei: bigint;
    try {
      priceWei = parseUnits(price.trim() || "0", NOMAD_DECIMALS);
      if (priceWei < 0n) throw new Error();
    } catch {
      return setStatus({ tone: "warn", text: "The price must be a plain number of $NOMAD, like 500 or 0." });
    }
    setBusy(true);
    try {
      const open = await readContract<boolean>(eth, contract, ABI, "mintingOpen");
      if (!open) return setStatus({ tone: "warn", text: "Minting is closed right now." });
      const taken = await readContract<bigint>(eth, contract, ABI, "agentOfPackage", [hash]);
      if (taken > 0n) return setStatus({ tone: "warn", text: `This exact package is already minted, as agent #${taken}.` });
      const fee = await readContract<bigint>(eth, contract, ABI, "mintFee");
      const balance = await readContract<bigint>(eth, TOKEN_CA, erc20Abi as Abi, "balanceOf", [account]);
      if (balance < fee) return setStatus({ tone: "warn", text: `Minting costs ${tokenAmount(Number(formatUnits(fee, NOMAD_DECIMALS)))}, and this wallet holds ${tokenAmount(Number(formatUnits(balance, NOMAD_DECIMALS)))}.` });
      await approveIfNeeded(eth, account, contract, fee, setStatus);
      setStatus({ tone: "info", text: fee > 0n ? "Step 2 of 2: confirm the mint in your wallet." : "Confirm the mint in your wallet." });
      const tx = await send(eth, account, { to: contract, data: encodeFunctionData({ abi: ABI, functionName: "mint", args: [n, hash, link, priceWei, fee] }) });
      setStatus({ tone: "info", text: "Waiting for confirmation…", hash: tx });
      await waitFor(eth, tx);
      setStatus({ tone: "ok", text: `Minted: ${n} is on Robinhood Chain.`, hash: tx });
      onDone();
    } catch (e) {
      setStatus({ tone: "bad", text: walletMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="mint-head">
      <div className="panel-head">
        <h3 id="mint-head" style={{ margin: 0 }}>
          Mint an agent
        </h3>
        <span className="muted" style={{ fontSize: "0.85rem" }}>
          {settings ? (settings.open ? `Fee: ${tokenAmount(Number(formatUnits(settings.fee, NOMAD_DECIMALS)))}` : "Minting is closed right now") : "Connect a wallet to see the fee"}
        </span>
      </div>
      <div className="panel-body">
        <div className="mint-form">
          <label>
            The agent&apos;s .nomad file
            <input type="file" accept=".nomad" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
            <span className="muted" style={{ fontWeight: 400, fontSize: "0.88rem" }}>
              Make one with <code>npx thenomad export &lt;your agent&gt;</code>. Only its SHA-256 is recorded; the file is never uploaded.
            </span>
          </label>
          {hash && <div className="agent-hash">SHA-256 {hash.slice(2)}</div>}
          <label>
            Name
            <input className="input" type="text" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Package link (optional)
            <input className="input" type="url" placeholder="https://…" value={uri} onChange={(e) => setUri(e.target.value)} />
            <span className="muted" style={{ fontWeight: 400, fontSize: "0.88rem" }}>
              Where others can download the file, for example a GitHub release. Anyone with the link can download it, so only share an agent you are happy to publish.
            </span>
          </label>
          <label>
            Price of a copy, in $NOMAD (0 for free)
            <input className="input" type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            <span className="muted" style={{ fontWeight: 400, fontSize: "0.88rem" }}>
              You receive the price minus Nomad&apos;s share{settings ? ` (${Number(settings.platformBps) / 100}%)` : ""}. You can change it later.
            </span>
          </label>
          <div>
            <button type="button" className="btn" disabled={busy || !account || !file} onClick={mint}>
              {busy ? "Working…" : "Mint"}
            </button>
          </div>
          {status && (
            <Notice tone={status.tone}>
              {status.text}
              {status.hash && (
                <>
                  {" "}
                  <a href={txUrl(status.hash)} target="_blank" rel="noopener noreferrer">
                    Transaction
                  </a>
                </>
              )}
            </Notice>
          )}
        </div>
      </div>
    </section>
  );
}

/** Minted agents, minting and copies. Shows a notice until the contract is deployed and set in the site. */
export function AgentsMarket() {
  const contract = AGENTS_CONTRACT;
  const [data, setData] = useState<AgentsSummary | null>(null);
  const [error, setError] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!contract) return;
    try {
      setData(await readAgents(undefined, contract));
      setError(false);
    } catch {
      setError(true);
    }
  }, [contract]);

  useEffect(() => {
    load();
    const t = setInterval(load, 120_000);
    return () => clearInterval(t);
  }, [load]);

  async function onConnect() {
    const eth = getWallet();
    if (!eth) return setNotice("No wallet found. Open this page in your wallet app's browser, or install a browser wallet.");
    try {
      const a = await connect(eth);
      setAccount(a);
      setNotice(null);
      if (contract) {
        const [open, fee, platformBps] = await Promise.all([
          readContract<boolean>(eth, contract, ABI, "mintingOpen"),
          readContract<bigint>(eth, contract, ABI, "mintFee"),
          readContract<bigint>(eth, contract, ABI, "platformBps")
        ]);
        setSettings({ open, fee, platformBps });
      }
    } catch (e) {
      setNotice(walletMessage(e));
    }
  }

  if (!contract) {
    return (
      <Notice title="Minting is not open yet">
        The agents contract is ready and tested, and has not been deployed yet. This page fills in when it is.
      </Notice>
    );
  }

  const refresh = () => {
    load();
    onConnect();
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="token-ca-row">
        {account ? (
          <span>
            Connected: <span className="mono">{short(account)}</span>
          </span>
        ) : (
          <button type="button" className="btn" onClick={onConnect}>
            Connect wallet
          </button>
        )}
        <a className="mono" href={addressUrl(contract)} target="_blank" rel="noopener noreferrer">
          Contract {short(contract)}
        </a>
      </div>
      {notice && <Notice tone="warn">{notice}</Notice>}

      <MintForm account={account} contract={contract} settings={settings} onDone={refresh} />

      <section aria-labelledby="agents-list">
        <h2 id="agents-list" style={{ fontSize: "1.3rem", margin: "8px 0 14px" }}>
          Minted agents
        </h2>
        {error && !data && <Notice tone="warn">The explorer did not answer just now. Trying again in two minutes.</Notice>}
        {!data && !error && <Skeleton rows={3} />}
        {data && data.agents.length === 0 && <p className="muted">No agent has been minted yet.</p>}
        {data && data.agents.length > 0 && (
          <div className="agents-grid">
            {data.agents.map((a) => (
              <AgentCard key={a.id} a={a} account={account} contract={contract} onDone={refresh} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
