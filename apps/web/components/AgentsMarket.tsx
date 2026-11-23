"use client";

import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, erc20Abi, formatUnits, parseUnits, type Abi } from "viem";
import { addressUrl, fmt, txUrl } from "@/lib/agent";
import { AGENTS_ABI } from "@/lib/agents-contract";
import { AGENTS_CONTRACT, readAgents, tokenAmount, NOMAD_DECIMALS, isEncryptedUri, type AgentsSummary, type MintedAgent } from "@/lib/economy";
import { GATEWAYS, MAX_PACKAGE_BYTES, decryptPackage, encryptPackage, openMessage, sha256Hex, storeMessage } from "@/lib/agent-package";
import { TOKEN_CA } from "@/lib/token";
import { connect, getWallet, readContract, send, sha256File, signMessage, waitFor, walletMessage, type Eip1193 } from "@/lib/wallet";
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

/** Fetches an encrypted package from IPFS, trying each gateway in turn. */
async function fetchFromIpfs(cid: string): Promise<Uint8Array> {
  for (const g of GATEWAYS) {
    try {
      const r = await fetch(`${g}${cid}`, { signal: AbortSignal.timeout(30_000) });
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch {
      // try the next gateway
    }
  }
  throw new Error("The package could not be fetched from IPFS just now. Try again in a minute.");
}

/** Signs in, gets the key, fetches and decrypts the package, checks it against the hash on-chain, and saves it. */
async function downloadPackage(eth: Eip1193, account: string, a: MintedAgent, say: (s: Status) => void) {
  const issuedAt = new Date().toISOString();
  say({ tone: "info", text: "Sign the message in your wallet to show this wallet has a copy. It costs nothing." });
  const signature = await signMessage(eth, account, openMessage(a.id, account, issuedAt));
  say({ tone: "info", text: "Checking your copy and fetching the package…" });
  const r = await fetch("/api/agents/key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: a.id, address: account, issuedAt, signature }) });
  const j = (await r.json().catch(() => ({}))) as { key?: string; cid?: string; error?: string };
  if (!r.ok || !j.key || !j.cid) throw new Error(j.error ?? "The key could not be fetched.");
  const plain = await decryptPackage(await fetchFromIpfs(j.cid), j.key);
  if ((await sha256Hex(plain)).toLowerCase() !== a.packageHash.toLowerCase()) throw new Error("The file does not match the SHA-256 recorded on-chain. Do not import it; tell the creator.");
  const url = URL.createObjectURL(new Blob([plain as BlobPart], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${a.name.replace(/[^\p{L}\p{N} ._-]/gu, "").trim() || `agent-${a.id}`}.nomad`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  say({ tone: "ok", text: "Downloaded, and it matches the SHA-256 recorded on-chain. Import it with npx thenomad import." });
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
      setStatus({ tone: "ok", text: isEncryptedUri(a.uri) ? "Done: you have a copy. Use Download to get the package." : "Done: you have a copy. Download the package below and check its SHA-256 before importing it with Nomad.", hash });
      onDone();
    } catch (e) {
      setStatus({ tone: "bad", text: walletMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    const eth = getWallet();
    if (!eth || !account) return setStatus({ tone: "warn", text: "Connect your wallet first." });
    setBusy(true);
    try {
      await downloadPackage(eth, account, a, setStatus);
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
        {isEncryptedUri(a.uri) ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !account} onClick={download} title="For the owner, and wallets with a copy">
            Download
          </button>
        ) : a.uri ? (
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
  const [delivery, setDelivery] = useState<"encrypted" | "link">("encrypted");
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
    let link = delivery === "link" ? uri.trim() : "";
    if (link && !/^https:\/\/[^\s"<>]{1,240}$/.test(link)) return setStatus({ tone: "warn", text: "The package link must be an https:// address (up to 240 characters), or left empty." });
    if (delivery === "encrypted" && file.size > MAX_PACKAGE_BYTES) return setStatus({ tone: "warn", text: "For encrypted delivery the package must be under 4 MB. Use a public link instead." });
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
      if (delivery === "encrypted") {
        setStatus({ tone: "info", text: "Encrypting the package on this computer…" });
        const plain = new Uint8Array(await file.arrayBuffer());
        if ((await sha256Hex(plain)).toLowerCase() !== hash.toLowerCase()) return setStatus({ tone: "bad", text: "The file changed since you chose it. Choose it again." });
        const { blob, keyHex } = await encryptPackage(plain);
        const issuedAt = new Date().toISOString();
        setStatus({ tone: "info", text: "Sign the message in your wallet to store the package's key. It costs nothing." });
        const signature = await signMessage(eth, account, storeMessage(hash, account, issuedAt));
        setStatus({ tone: "info", text: "Uploading the encrypted package…" });
        const r = await fetch("/api/agents/package", {
          method: "POST",
          headers: { "content-type": "application/octet-stream", "x-nomad-package-hash": hash, "x-nomad-key": keyHex, "x-nomad-address": account, "x-nomad-issued-at": issuedAt, "x-nomad-signature": signature },
          body: blob as BodyInit
        });
        const j = (await r.json().catch(() => ({}))) as { uri?: string; error?: string };
        if (!r.ok || !j.uri) return setStatus({ tone: "bad", text: j.error ?? "The package could not be stored. Nothing was minted." });
        link = j.uri;
      }
      await approveIfNeeded(eth, account, contract, fee, setStatus);
      setStatus({ tone: "info", text: fee > 0n ? "Last step: confirm the mint in your wallet." : "Confirm the mint in your wallet." });
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
              Make one with <code>npx thenomad export &lt;your agent&gt;</code>. Its SHA-256 is recorded on-chain, so anyone can check a download against it.
            </span>
          </label>
          {hash && <div className="agent-hash">SHA-256 {hash.slice(2)}</div>}
          <label>
            Name
            <input className="input" type="text" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <fieldset className="mint-choice">
            <legend>How others get the package</legend>
            <label className="mint-radio">
              <input type="radio" name="delivery" checked={delivery === "encrypted"} onChange={() => setDelivery("encrypted")} />
              <span>
                Encrypted, only for wallets with a copy
                <span className="muted"> The file is encrypted on this computer and stored on IPFS. Only you, the agent&apos;s owner and wallets with a copy can download and open it. Up to 4 MB.</span>
              </span>
            </label>
            <label className="mint-radio">
              <input type="radio" name="delivery" checked={delivery === "link"} onChange={() => setDelivery("link")} />
              <span>
                A public link
                <span className="muted"> Anyone with the link can download it, copy or not, so only use this for an agent you are happy to publish.</span>
              </span>
            </label>
          </fieldset>
          {delivery === "link" && (
            <label>
              Package link (optional)
              <input className="input" type="url" placeholder="https://…" value={uri} onChange={(e) => setUri(e.target.value)} />
              <span className="muted" style={{ fontWeight: 400, fontSize: "0.88rem" }}>
                Where others can download the file, for example a GitHub release.
              </span>
            </label>
          )}
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
