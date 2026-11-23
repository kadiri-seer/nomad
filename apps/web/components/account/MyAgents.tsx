"use client";

/**
 * A person's agents on their account page: each one's status and latest move, and for each agent its wallet,
 * holdings and moves, with Fund, Withdraw, Pause or Resume, and how often it runs.
 */
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, erc20Abi, parseUnits, type Address, type Hex } from "viem";
import { USDG } from "@/lib/accounts/chain";
import { accountClient, fmtUsdg, publicClient, type Call } from "@/lib/accounts/client";
import { ownerActionMessage, RUN_EVERY_HOURS, type Move, type Position } from "@/lib/agents/shared";
import { Sheet } from "./Sheet";
import { writeSnapshot } from "./snapshot";
import type { Client, Confirm } from "./types";

type AgentView = {
  id: string;
  name: string;
  template: "trader" | "blank";
  status: "active" | "paused";
  account: Address;
  salt: string;
  runEveryHours: number;
  limits: { perTradeUsd: string; tradesPerDay: number };
  waitingFor: string | null;
  lastMove?: Move | null;
};

const fail = (e: unknown) => window.dispatchEvent(new CustomEvent("nomad-account-error", { detail: (e as Error)?.message ?? "Something went wrong." }));
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const erc20Balance = (token: Address, holder: Address) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
const transfer = (token: Address, to: Address, amount: bigint): Call => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) });

export function MyAgents({ client, onConfirm, version }: { client: Client; onConfirm: (c: Confirm) => void; version: number }) {
  const owner = client.account.address as Address;
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [open, setOpen] = useState<AgentView | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/agents/mine?owner=${owner}`, { cache: "no-store" });
      const j = await r.json();
      setAgents(r.ok ? j.agents : []);
      if (r.ok) writeSnapshot({ agents: (j.agents as AgentView[]).map((a) => ({ name: a.name, status: a.status })) });
    } catch {
      setAgents([]);
    }
  }, [owner]);
  useEffect(() => {
    load();
  }, [load, version]);

  if (!agents || agents.length === 0) return null;
  return (
    <section className="acct-card" aria-labelledby="my-agents">
      <h2 id="my-agents" className="acct-h3">
        Your agents
      </h2>
      {agents.map((a) => (
        <button key={a.id} type="button" className="acct-option" onClick={() => setOpen(a)}>
          <span>
            <strong>
              {a.name} <span className="acct-small">· {a.status === "active" ? "Running" : "Paused"}</span>
            </strong>
            <span className="acct-small">{a.waitingFor ? `Waiting for ${a.waitingFor}` : a.lastMove ? `${a.lastMove.text.slice(0, 90)} (${ago(a.lastMove.at)})` : "No runs yet"}</span>
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
    fetch(`/api/agents/one/${agent.id}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        setMoves(j.moves ?? []);
        setPositions(j.positions ?? []);
      })
      .catch(() => undefined);
    erc20Balance(USDG, agent.account).then(setUsdg).catch(() => setUsdg(null));
  }, [agent.id, agent.account]);

  const change = async (action: "pause" | "resume" | "schedule", runEveryHours?: number) => {
    setBusy(true);
    try {
      const at = Date.now();
      const label = action === "schedule" ? `run every ${runEveryHours} hours` : action;
      const signature = await client.owner.signMessage({ message: ownerActionMessage(agent.id, label, at) });
      const r = await fetch(`/api/agents/one/${agent.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, at, signature, runEveryHours }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "That did not go through.");
      onChanged({ ...agent, ...j.agent });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const doFund = () => {
    let amount: bigint;
    try {
      amount = parseUnits(fund || "0", 6);
    } catch {
      return fail(new Error("Enter an amount in USDG."));
    }
    if (amount <= 0n) return fail(new Error("Enter an amount in USDG."));
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
      const via = await accountClient(client.owner, BigInt(agent.salt));
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
        build: async () => tokens.map((t) => transfer(t.token, main, t.amount)),
        done: { title: "Withdrawn", body: "Everything in the agent's wallet is back in your account." }
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
        {agent.template === "trader" ? "Trader" : "Its own instructions"} · up to {agent.limits.perTradeUsd} USDG a trade, {agent.limits.tradesPerDay} a day ·{" "}
        {agent.status === "active" ? "Running" : "Paused"}
      </p>
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
      <h3 className="acct-h3">Moves</h3>
      <ol className="acct-moves">
        {moves.length === 0 && <li className="acct-small">No moves yet.</li>}
        {moves.map((m, i) => (
          <li key={i}>
            <span className="acct-small">{ago(m.at)}</span>
            <span>{m.text}</span>
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
