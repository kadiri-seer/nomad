"use client";

/**
 * A person's agents on their account page: each one's status and latest move, and for each agent its wallet,
 * holdings and moves, with Fund, Withdraw, Pause or Resume, and how often it runs.
 */
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, erc20Abi, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { USDG } from "@/lib/accounts/chain";
import { accountClient, fmtUsdg, publicClient, rememberTokens, type Call } from "@/lib/accounts/client";
import { DEFAULT_RESEARCH, DEFAULT_STOCKS, hiresAction, type HireLimits, ownerActionMessage, RUN_EVERY_HOURS, viewMessage, type Move, type Position } from "@/lib/agents/shared";
import { hostedEnterMessage, linkMessage } from "@/lib/bounties/shared";
import { Sheet } from "./Sheet";
import { writeSnapshot } from "./snapshot";
import type { Client, Confirm } from "./types";

type AgentView = {
  id: string;
  name: string;
  template: "trader" | "blank" | "researcher" | "stocks";
  status: "active" | "paused";
  account: Address;
  salt: string;
  runEveryHours: number;
  limits: { perTradeUsd: string; tradesPerDay: number };
  hires?: HireLimits;
  waitingFor: string | null;
  lastMove?: Move | null;
};

/** The hire limits a creator can pick: hires a day, and the most per hire in USDG. */
const HIRE_CHOICES: [number, string][] = [
  [1, "0.25"],
  [3, "0.25"],
  [5, "0.50"],
  [10, "1.00"]
];

const fail = (e: unknown) => window.dispatchEvent(new CustomEvent("nomad-account-error", { detail: (e as Error)?.message ?? "Something went wrong." }));
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const erc20Balance = (token: Address, holder: Address) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
const transfer = (token: Address, to: Address, amount: bigint): Call => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) });

export function MyAgents({ client, onConfirm, version, onAgents }: { client: Client; onConfirm: (c: Confirm) => void; version: number; onAgents?: (wallets: Address[]) => void }) {
  const owner = client.account.address as Address;
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [open, setOpen] = useState<AgentView | null>(null);
  const [bountyStatus, setBountyStatus] = useState<Record<string, string>>({});
  const [entering, setEntering] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("bounty");
    if (id && /^[a-z0-9-]{1,60}$/.test(id)) setEntering(id);
  }, []);
  const load = useCallback(async () => {
    fetch(`/api/bounties/status?owner=${owner}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((j: { entries: { agentId?: string; status: string }[] }) => setBountyStatus(Object.fromEntries(j.entries.filter((e) => e.agentId).map((e) => [e.agentId!, e.status]))))
      .catch(() => undefined);
    try {
      // Moves and reports are only for the creator: the sign-in wallet signs to see them (no prompt).
      // If signing is not ready, the list still shows, without the latest moves.
      const signed = async () => {
        const at = Date.now();
        const signature = await client.owner.signMessage({ message: viewMessage(client.signer, at) });
        return fetch("/api/agents/mine", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ signer: client.signer, at, signature }) });
      };
      const r = await signed().catch(() => fetch(`/api/agents/mine?owner=${owner}`, { cache: "no-store" }));
      const j = await r.json();
      setAgents(r.ok ? j.agents : []);
      if (r.ok) onAgents?.((j.agents as AgentView[]).map((a) => a.account));
      if (r.ok) writeSnapshot({ agents: (j.agents as AgentView[]).map((a) => ({ name: a.name, status: a.status })) });
    } catch {
      setAgents([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  useEffect(() => {
    load();
  }, [load, version]);

  const enterSheet = entering && agents && (
    <EnterSheet
      client={client}
      bountyId={entering}
      agents={agents}
      onClose={() => {
        setEntering(null);
        window.history.replaceState(null, "", window.location.pathname);
        load();
      }}
    />
  );
  if (!agents || agents.length === 0) return enterSheet || null;
  return (
    <section className="acct-card" aria-labelledby="my-agents">
      {enterSheet}
      <h2 id="my-agents" className="acct-h3">
        Your agents
      </h2>
      {agents.map((a) => (
        <button key={a.id} type="button" className="acct-option" onClick={() => setOpen(a)}>
          <span>
            <strong>
              {a.name} <span className="acct-small">· {a.status === "active" ? "Running" : "Paused"}</span>
            </strong>
            <span className="acct-small">{bountyStatus[a.id] ?? (a.waitingFor ? `Waiting for ${a.waitingFor}` : a.lastMove ? `${a.lastMove.text.slice(0, 90)} (${ago(a.lastMove.at)})` : "No runs yet")}</span>
          </span>
          <span aria-hidden="true">›</span>
        </button>
      ))}
      {open && (
        <AgentSheet
          client={client}
          agent={open}
          onClose={() => {
            setOpen(null);
            load();
          }}
          onConfirm={(c) => {
            setOpen(null);
            onConfirm(c);
          }}
          onChanged={(a) => {
            setOpen(a);
            load();
          }}
        />
      )}
    </section>
  );
}

function AgentSheet({ client, agent, onClose, onConfirm, onChanged }: { client: Client; agent: AgentView; onClose: () => void; onConfirm: (c: Confirm) => void; onChanged: (a: AgentView) => void }) {
  const [moves, setMoves] = useState<Move[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [usdg, setUsdg] = useState<bigint | null>(null);
  const [fund, setFund] = useState("5");
  const [busy, setBusy] = useState(false);
  const main = client.account.address as Address;

  useEffect(() => {
    const at = Date.now();
    client.owner
      .signMessage({ message: ownerActionMessage(agent.id, "view", at) })
      .then((signature) => fetch(`/api/agents/one/${agent.id}`, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "view", at, signature }) }))
      .then((r) => r.json())
      .then((j) => {
        setMoves(j.moves ?? []);
        setPositions(j.positions ?? []);
      })
      .catch(() => undefined);
    erc20Balance(USDG, agent.account).then(setUsdg).catch(() => setUsdg(null));
  }, [agent.id, agent.account]);

  const change = async (action: "pause" | "resume" | "schedule" | "hires", runEveryHours?: number, hires?: HireLimits | null) => {
    setBusy(true);
    try {
      const at = Date.now();
      const label = action === "schedule" ? `run every ${runEveryHours} hours` : action === "hires" ? hiresAction(hires ?? null) : action;
      const signature = await client.owner.signMessage({ message: ownerActionMessage(agent.id, label, at) });
      const r = await fetch(`/api/agents/one/${agent.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, at, signature, runEveryHours, hires }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "That did not go through.");
      onChanged({ ...agent, ...j.agent });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const doFund = async () => {
    let amount: bigint;
    try {
      amount = parseUnits(fund || "0", 6);
    } catch {
      return fail(new Error("Enter an amount in USDG."));
    }
    if (amount <= 0n) return fail(new Error("Enter an amount in USDG."));
    if (amount < 100_000n) return fail(new Error("Fund at least 0.10 USDG."));
    const have = await erc20Balance(USDG, main).catch(() => null);
    if (have !== null && have < amount) return fail(new Error(`Your account has ${fmtUsdg(have)} USDG. Add funds first, or fund a smaller amount.`));
    onConfirm({
      title: `Fund ${agent.name}`,
      amount: `-${fmtUsdg(amount)} USDG`,
      amountNote: "to the agent's own wallet",
      rows: [
        ["To", `Agent wallet ${agent.account.slice(0, 6)}...${agent.account.slice(-4)}`],
        ["Network fee", "Included"]
      ],
      note: "You can take it all back with Withdraw at any time.",
      build: async () => [transfer(USDG, agent.account, amount)],
      done: { title: "Funded", body: `${fmtUsdg(amount)} USDG is in ${agent.name}'s wallet.` }
    });
  };

  const doWithdraw = async () => {
    setBusy(true);
    try {
      const via = await accountClient(client.owner, BigInt(agent.salt), client.getToken);
      if (via.account.address.toLowerCase() !== agent.account.toLowerCase()) throw new Error("This agent's wallet is not yours to withdraw from.");
      const tokens: { token: Address; symbol: string; amount: bigint }[] = [];
      const u = await erc20Balance(USDG, agent.account);
      if (u > 0n) tokens.push({ token: USDG, symbol: "USDG", amount: u });
      for (const p of positions) {
        const b = await erc20Balance(p.token, agent.account).catch(() => 0n);
        if (b > 0n) tokens.push({ token: p.token, symbol: p.symbol, amount: b });
      }
      if (!tokens.length) throw new Error("The agent's wallet is empty.");
      onConfirm({
        via,
        title: `Withdraw from ${agent.name}`,
        amount: u > 0n ? `+${fmtUsdg(u)} USDG` : `+${tokens.length} token${tokens.length > 1 ? "s" : ""}`,
        amountNote: "back to your account",
        rows: [...tokens.filter((t) => t.token !== USDG).map((t) => ["Also", t.symbol] as [string, string]), ["To", "Your account"], ["Network fee", "Included"]],
        note: agent.status === "active" ? "Pause the agent too if you do not want it to trade when it is funded again." : undefined,
        build: async () => {
          // The tokens show in the account's Other tokens, where they can be sold for USDG or sent.
          rememberTokens(main, tokens.filter((t) => t.token !== USDG).map((t) => t.token));
          return tokens.map((t) => transfer(t.token, main, t.amount));
        },
        done: { title: "Withdrawn", body: "Everything in the agent's wallet is back in your account. Tokens other than USDG are under Other tokens, where you can sell or send them." }
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={agent.name} onClose={onClose}>
      <p className="acct-small">
        {agent.template === "researcher"
          ? "Researcher · writes you a report each run, never trades"
          : `${templateLabel(agent.template)} · up to ${agent.limits.perTradeUsd} USDG a trade, ${agent.limits.tradesPerDay} a day`}{" "}
        · {agent.status === "active" ? "Running" : "Paused"}
      </p>
      {agent.template !== "researcher" && (
      <>
      <div className="acct-between">
        <span>Its wallet</span>
        <strong>{usdg === null ? "..." : `${fmtUsdg(usdg)} USDG`}</strong>
      </div>
      <code className="acct-address">{agent.account}</code>
      {positions.length > 0 && <p className="acct-small">Holding: {positions.map((p) => p.symbol).join(", ")}</p>}
      <div className="acct-grid2">
        <input className="acct-input" aria-label="Amount to fund, in USDG" value={fund} inputMode="decimal" onChange={(e) => setFund(e.target.value.replace(/[^0-9.]/g, "").slice(0, 10))} />
        <button type="button" className="acct-primary" onClick={doFund} disabled={busy}>
          Fund
        </button>
      </div>
      </>
      )}
      <div className="acct-grid2">
        <button type="button" className="acct-secondary" onClick={doWithdraw} disabled={busy}>
          Withdraw all
        </button>
        <button type="button" className="acct-secondary" onClick={() => change(agent.status === "active" ? "pause" : "resume")} disabled={busy}>
          {agent.status === "active" ? "Pause" : "Resume"}
        </button>
      </div>
      <label className="acct-field">
        <span>How often it runs</span>
        <select value={agent.runEveryHours} disabled={busy} onChange={(e) => change("schedule", Number(e.target.value))}>
          {RUN_EVERY_HOURS.map((h) => (
            <option key={h} value={h}>
              {h === 1 ? "Every hour" : h === 24 ? "Once a day" : `Every ${h} hours`}
            </option>
          ))}
        </select>
      </label>
      <label className="acct-field">
        <span>Hiring Zero Lux agents</span>
        <select
          value={agent.hires ? `${agent.hires.perDay}:${agent.hires.maxUsd}` : "off"}
          disabled={busy}
          onChange={(e) => {
            const [perDay, maxUsd] = e.target.value.split(":");
            change("hires", undefined, e.target.value === "off" ? null : { perDay: Number(perDay), maxUsd });
          }}
        >
          <option value="off">Off</option>
          {agent.hires && !HIRE_CHOICES.some(([d, m]) => d === agent.hires!.perDay && m === agent.hires!.maxUsd) && (
            <option value={`${agent.hires.perDay}:${agent.hires.maxUsd}`}>
              Up to {agent.hires.perDay} a day, {agent.hires.maxUsd} USDG each
            </option>
          )}
          {HIRE_CHOICES.map(([d, m]) => (
            <option key={`${d}:${m}`} value={`${d}:${m}`}>
              Up to {d} a day, {m} USDG each
            </option>
          ))}
        </select>
      </label>
      {agent.hires && <p className="acct-small">It can pay other agents on Zero Lux for a job during its runs. Each hire comes out of your credits, and failed hires are given back.</p>}
      {agent.template !== "trader" && <Instructions client={client} agent={agent} />}
      <h3 className="acct-h3">{agent.template === "researcher" ? "Reports" : "Moves"}</h3>
      <ol className="acct-moves">
        {moves.length === 0 && <li className="acct-small">No moves yet.</li>}
        {moves.map((m, i) => (
          <li key={i}>
            <span className="acct-small">{ago(m.at)}</span>
            <span style={m.report ? { whiteSpace: "pre-line" } : undefined}>{m.text}</span>
            {m.tx && (
              <a href={`https://robinhoodchain.blockscout.com/tx/${m.tx as Hex}`} target="_blank" rel="noopener noreferrer" className="acct-small">
                Transaction
              </a>
            )}
          </li>
        ))}
      </ol>
    </Sheet>
  );
}

const templateLabel = (t: string) => (t === "researcher" ? "Researcher" : t === "trader" ? "Trader" : t === "stocks" ? "Stocks" : "Its own instructions");

/** Reading and changing an agent's instructions, both signed by its creator (nobody else can see them). */
function Instructions({ client, agent }: { client: Client; agent: AgentView }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const send = async (action: "read" | "instructions", label: string, extra: object = {}) => {
    const at = Date.now();
    const signature = await client.owner.signMessage({ message: ownerActionMessage(agent.id, label, at) });
    const r = await fetch(`/api/agents/one/${agent.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, at, signature, ...extra }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "That did not go through.");
    return j;
  };
  const open = async () => {
    setBusy(true);
    try {
      setText(((await send("read", "read instructions")) as { instructions: string }).instructions);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const t = (text ?? "").trim();
    setBusy(true);
    try {
      await send("instructions", `set instructions ${keccak256(toHex(t))}`, { instructions: t });
      setSaved(true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  if (text === null)
    return (
      <button type="button" className="acct-secondary" onClick={open} disabled={busy}>
        {busy ? "Opening..." : "Edit instructions"}
      </button>
    );
  return (
    <div className="acct-stack">
      <label className="acct-field">
        <span>Instructions</span>
        <textarea value={text} rows={5} maxLength={4000} placeholder={agent.template === "researcher" ? DEFAULT_RESEARCH : agent.template === "stocks" ? DEFAULT_STOCKS : undefined} onChange={(e) => (setText(e.target.value), setSaved(false))} />
      </label>
      <p className="acct-small">Only you can see these. Venin checks them before they are saved, and they never change the agent&apos;s limits.</p>
      <button type="button" className="acct-primary" onClick={save} disabled={busy || saved}>
        {saved ? "Saved" : busy ? "Saving..." : "Save instructions"}
      </button>
    </div>
  );
}

type BountyView = { id: string; title: string; brief: string; result: string; closes: string; state: string; prize: { amount: string; token: string } };

/** Entering a bounty from its page: pick an agent and sign. An agent running elsewhere is linked here first. */
function EnterSheet({ client, bountyId, agents, onClose }: { client: Client; bountyId: string; agents: AgentView[]; onClose: () => void }) {
  const [bounty, setBounty] = useState<BountyView | null>(null);
  const [missing, setMissing] = useState(false);
  const [pick, setPick] = useState<string | null>(agents[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [outside, setOutside] = useState(false);
  useEffect(() => {
    fetch(`/api/bounties/${bountyId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => setBounty(j.bounty))
      .catch(() => setMissing(true));
  }, [bountyId]);

  const enter = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      const at = Date.now();
      const signature = await client.owner.signMessage({ message: hostedEnterMessage(bountyId, pick, at) });
      const r = await fetch(`/api/bounties/${bountyId}/enter`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: pick, at, signature }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "That did not go through.");
      setDone(agents.find((a) => a.id === pick)?.name ?? "Your agent");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const title = bounty ? `Enter ${bounty.title}` : "Enter a bounty";
  return (
    <Sheet title={title} onClose={onClose}>
      {missing && <p className="acct-body">This bounty is not open right now.</p>}
      {!missing && !bounty && <p className="acct-small">Loading...</p>}
      {bounty && done && (
        <>
          <p className="acct-body">{done} is in. On its next run it does the task its own way, then hands the work in by itself. You will see how it goes on its card.</p>
          <button type="button" className="acct-primary" onClick={onClose}>
            Done
          </button>
        </>
      )}
      {bounty && !done && bounty.state !== "open" && <p className="acct-body">This bounty is not open for entries right now.</p>}
      {bounty && !done && bounty.state === "open" && (
        <>
          <p className="acct-body">{bounty.brief}</p>
          {agents.length ? (
            <fieldset className="acct-fieldset">
              <legend>Which agent enters</legend>
              {agents.map((a) => (
                <button key={a.id} type="button" className="acct-option" aria-pressed={pick === a.id} onClick={() => setPick(a.id)}>
                  <span>
                    <strong>{a.name}</strong>
                    <span className="acct-small">{templateLabel(a.template)}</span>
                  </span>
                  <span className="acct-dot" aria-hidden="true" />
                </button>
              ))}
            </fieldset>
          ) : (
            <p className="acct-body">Create an agent first, then come back to this bounty.</p>
          )}
          {agents.length > 0 && (
            <button type="button" className="acct-primary" onClick={enter} disabled={busy || !pick}>
              {busy ? "Entering..." : "Enter"}
            </button>
          )}
          <p className="acct-small">One entry per account. Its own setup decides how it does the work, so you can edit its instructions first.</p>
          {!outside ? (
            <button type="button" className="acct-quiet" onClick={() => setOutside(true)}>
              My agent runs somewhere else
            </button>
          ) : (
            <LinkOutside client={client} bountyId={bountyId} />
          )}
        </>
      )}
    </Sheet>
  );
}

/** Links an agent that runs outside Nomad (by its wallet) to this account, so it can enter with its own signature. */
function LinkOutside({ client, bountyId }: { client: Client; bountyId: string }) {
  const [wallet, setWallet] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(false);
  const link = async () => {
    const w = wallet.trim();
    const n = name.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return fail(new Error("Enter the agent's wallet address."));
    if (!n) return fail(new Error("Give the agent a name."));
    setBusy(true);
    try {
      const at = Date.now();
      const clean = n.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 40);
      const signature = await client.owner.signMessage({ message: linkMessage(w, clean, at) });
      const r = await fetch("/api/bounties/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signer: client.signer, wallet: w, name: clean, at, signature }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "That did not go through.");
      setLinked(true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  if (linked)
    return (
      <p className="acct-body">
        Linked. Your agent now enters and hands in its work itself, signing with its wallet. The steps are on the <a href={`/bounties/${bountyId}#outside`}>bounty&apos;s page</a>. A prize goes to this account.
      </p>
    );
  return (
    <div className="acct-stack">
      <label className="acct-field">
        <span>Your agent&apos;s wallet address</span>
        <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x..." spellCheck={false} />
      </label>
      <label className="acct-field">
        <span>Its name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>
      <button type="button" className="acct-secondary" onClick={link} disabled={busy}>
        {busy ? "Linking..." : "Link this agent"}
      </button>
    </div>
  );
}
