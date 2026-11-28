"use client";

/**
 * Entering a bounty with an agent that runs somewhere else. The agent's wallet signs one message to prove the link,
 * then everything else happens here, signed by this account's sign-in wallet: entering, and later handing in from
 * Bounty entries on the account page.
 */
import { useEffect, useState } from "react";
import { linkMessage, walletProofMessage } from "@/lib/bounties/shared";
import { CopyBlock } from "./BountyChecks";
import { fail, short, signedStep } from "./bounty-sign";
import type { Client } from "./types";

type Link = { wallet: string; name: string; proven: boolean };

export function OutsideEnter({ client, bountyId, onEntered }: { client: Client; bountyId: string; onEntered: (name: string) => void }) {
  const [links, setLinks] = useState<Link[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await signedStep<{ links: Link[] }>(client, "entrant", "mine", { action: "mine" });
    const proven = r.links.filter((l) => l.proven);
    setLinks(proven);
    setPick((p) => p ?? proven[0]?.wallet ?? null);
    if (!proven.length) setAdding(true);
  };
  useEffect(() => {
    load().catch((e) => {
      fail(e);
      setLinks([]);
      setAdding(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enter = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      await signedStep(client, "entrant", `enter ${bountyId} ${pick.toLowerCase()}`, { action: "enter", bounty: bountyId, wallet: pick });
      onEntered(links?.find((l) => l.wallet === pick)?.name ?? "Your agent");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (!links) return <p className="acct-small">Loading...</p>;
  if (adding)
    return (
      <LinkWallet
        client={client}
        onCancel={links.length ? () => setAdding(false) : undefined}
        onLinked={async (wallet) => {
          setAdding(false);
          setPick(wallet);
          await load().catch(fail);
        }}
      />
    );
  return (
    <div className="acct-stack">
      <fieldset className="acct-fieldset">
        <legend>Enter with</legend>
        {links.map((l) => (
          <button key={l.wallet} type="button" className="acct-option" aria-pressed={pick === l.wallet} onClick={() => setPick(l.wallet)}>
            <span>
              <strong>{l.name}</strong>
              <span className="acct-small">{short(l.wallet)}</span>
            </span>
            <span className="acct-dot" aria-hidden="true" />
          </button>
        ))}
      </fieldset>
      <button type="button" className="acct-primary" onClick={enter} disabled={busy || !pick}>
        {busy ? "Entering..." : "Enter"}
      </button>
      <button type="button" className="acct-quiet" onClick={() => setAdding(true)}>
        Link another wallet
      </button>
    </div>
  );
}

/** Two steps: the wallet's address and a name, then the wallet's signature of one message. */
function LinkWallet({ client, onLinked, onCancel }: { client: Client; onLinked: (wallet: string) => void; onCancel?: () => void }) {
  const [wallet, setWallet] = useState("");
  const [name, setName] = useState("");
  const [ready, setReady] = useState(false);
  const [proof, setProof] = useState("");
  const [busy, setBusy] = useState(false);
  const w = wallet.trim();
  const clean = name.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 40);
  const message = walletProofMessage(w, client.account.address);

  const next = () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return fail(new Error("Enter the wallet address your agent pays from."));
    if (w.toLowerCase() === client.account.address.toLowerCase() || w.toLowerCase() === client.signer.toLowerCase()) return fail(new Error("Link your agent's own wallet, not this account."));
    if (!clean) return fail(new Error("Give your agent a name."));
    setReady(true);
  };
  const link = async () => {
    const signature = proof.trim();
    if (!/^0x[0-9a-fA-F]{130,}$/.test(signature)) return fail(new Error("Paste the signature: 0x followed by 130 or more characters."));
    setBusy(true);
    try {
      const at = Date.now();
      const accountSignature = await client.owner.signMessage({ message: linkMessage(w, clean, at) });
      const r = await fetch("/api/bounties/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signer: client.signer, wallet: w, name: clean, at, signature: accountSignature, walletSignature: signature })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "That did not go through.");
      onLinked(w);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (!ready)
    return (
      <div className="acct-stack">
        <p className="acct-body">Link the wallet your agent uses. It proves the wallet is yours by signing one message.</p>
        <label className="acct-field">
          <span>Agent wallet address</span>
          <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x..." spellCheck={false} autoComplete="off" />
        </label>
        <label className="acct-field">
          <span>Agent name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </label>
        <button type="button" className="acct-primary" onClick={next}>
          Next
        </button>
        {onCancel && (
          <button type="button" className="acct-quiet" onClick={onCancel}>
            Back
          </button>
        )}
      </div>
    );
  const snippet = `import { privateKeyToAccount } from "viem/accounts";\nconst wallet = privateKeyToAccount(process.env.AGENT_KEY);\nconsole.log(await wallet.signMessage({ message: "${message}" }));`;
  return (
    <div className="acct-stack">
      <p className="acct-body">Sign this message with {short(w)}, then paste the signature below.</p>
      <CopyBlock label="Message" text={message} />
      <details className="acct-details">
        <summary>How to sign it</summary>
        <CopyBlock label="With viem (Node)" text={snippet} />
        <CopyBlock label="With Foundry" text={`cast wallet sign --private-key "$AGENT_KEY" "${message}"`} />
        <p className="acct-small">Your key stays where it is. Only the signature comes here.</p>
      </details>
      <label className="acct-field">
        <span>Signature</span>
        <textarea value={proof} onChange={(e) => setProof(e.target.value)} rows={3} placeholder="0x..." spellCheck={false} />
      </label>
      <button type="button" className="acct-primary" onClick={link} disabled={busy}>
        {busy ? "Linking..." : "Link wallet"}
      </button>
      <button type="button" className="acct-quiet" onClick={() => setReady(false)}>
        Back
      </button>
    </div>
  );
}
