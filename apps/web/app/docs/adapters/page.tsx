import { ALL_INFOS } from "@nomad/adapters/catalog";
import { SUPPORT_DESCRIPTIONS, SUPPORT_LABELS } from "@nomad/core";
import { CATEGORY_LABELS } from "@nomad/compatibility";
import { COMPONENT_CATEGORIES } from "@nomad/schema";
import { Badge } from "@/components/ui";

export const metadata = { title: "Platforms", description: "What Nomad can read and write on each platform, category by category." };

// Adapters that ship but have not yet been run against the real application.
const IN_PROGRESS: Record<string, string> = {
  elizaos: "ElizaOS adapter: in progress, nothing is labelled supported until it ships and has been tested. Characters it writes pass ElizaOS 1.7.2's own character schema; they have not been loaded by a running ElizaOS agent yet."
};

const SHORT: Record<string, string> = { full: "Full", convert: "Converts", manual: "Manual", unsupported: "No" };

export default function Adapters() {
  return (
    <>
      <p className="label">Documentation</p>
      <h1>Platforms and capabilities</h1>
      <p>Every adapter declares what it supports instead of claiming to be compatible. This page is generated from those declarations.</p>

      <h2>Support levels</h2>
      <dl className="kv">
        {(["FULL", "PARTIAL", "EXPERIMENTAL", "GUIDED", "UNAVAILABLE"] as const).map((s) => (
          <div key={s} style={{ display: "contents" }}>
            <dt>
              <Badge kind={s}>{SUPPORT_LABELS[s]}</Badge>
            </dt>
            <dd>{SUPPORT_DESCRIPTIONS[s]}</dd>
          </div>
        ))}
      </dl>

      <h2>Write capabilities</h2>
      <p>What Nomad can put into each platform. Read support is listed per platform below.</p>
      <div className="panel table-wrap" style={{ maxWidth: "none" }}>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Platform</th>
              {COMPONENT_CATEGORIES.filter((c) => c !== "project").map((c) => (
                <th scope="col" key={c}>
                  {CATEGORY_LABELS[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ALL_INFOS.map((a) => (
              <tr key={a.id}>
                <td style={{ whiteSpace: "nowrap" }}>
                  <strong>{a.displayName}</strong>
                  <br />
                  <Badge kind={a.support}>{a.support.toLowerCase()}</Badge>
                </td>
                {COMPONENT_CATEGORIES.filter((c) => c !== "project").map((c) => (
                  <td key={c}>
                    <Badge kind={a.capabilities[c].write}>{SHORT[a.capabilities[c].write]}</Badge>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Details</h2>
      {ALL_INFOS.filter((a) => a.support !== "GUIDED").map((a) => (
        <section key={a.id} id={a.id}>
          <h3>
            {a.displayName} <Badge kind={a.support}>{a.support.toLowerCase()}</Badge>
          </h3>
          <p>{a.description}</p>
          {IN_PROGRESS[a.id] && <p>{IN_PROGRESS[a.id]}</p>}
          <p className="muted">
            Built for: {a.supportedVersions}. {a.defaultLocations.length ? `Default location ${a.defaultLocations.join(", ")}.` : "Point Nomad at the project folder."} Id <code>{a.id}</code>.
          </p>
          <ul>
            {COMPONENT_CATEGORIES.filter((c) => a.capabilities[c].notes).map((c) => (
              <li key={c}>
                <strong>{CATEGORY_LABELS[c]}:</strong> {a.capabilities[c].notes}
              </li>
            ))}
            {a.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>
      ))}
      <h2>Priors setups</h2>
      <p>
        We are exploring Priors setups: moving the Priors MCP servers and Hermes plugin settings between agents, with keys and limits shown as things you set again. Priors is a credit service for agents on Robinhood Chain. Wallet keys, key files and on-chain state are never read or moved. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/priors-setups.md">Priors setups guide</a>.
      </p>
      <h2>Oak setups</h2>
      <p>
        Oak Agent Kit is a local wallet and tools for Robinhood Chain projects, used by an agent through one MCP server. Nomad moves the Oak MCP entry (<code>oak mcp</code>, <code>npx @oakagentkit/addon</code>, or Oak&apos;s Claude Code plugin) into the destination&apos;s own format, the same entry Oak&apos;s own setup writes. <code>~/.oak</code>, where Oak keeps its wallet and settings, is never read or moved. On another computer, Oak starts with a new wallet unless you restore yours there yourself. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/oak-setups.md">Oak setups guide</a>.
      </p>
      <h2>Hedgehood setups</h2>
      <p>
        Hedgehood is an options market for AI agents on Robinhood Chain, traded through a local MCP server with a session key that can trade but never withdraw. Nomad moves the Hedgehood server (<code>npx @hedgehood-io/mcp</code> or <code>hedgehood-mcp</code>), its hosted read-only server and its Claude Code plugin into the destination&apos;s own format, and the preview says whether each server is on mainnet (real USDG) or the testnet. Key files and <code>~/.hedgehood</code> are never read or moved, and raw keys are never written as values. On another computer, create and authorize a new session there. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/hedgehood-setups.md">Hedgehood setups guide</a>.
      </p>
      <h2>BrainChain setups</h2>
      <p>
        BrainChain verifies AI agent work and settles payments for it on Robinhood Chain and Base, through a local MCP server. Nomad moves the BrainChain server (<code>npx brainchain-mcp</code> or <code>brainchain-mcp</code>) and the BrainChain skills into the destination&apos;s own format, OpenClaw included, and the preview says whether each server pays on mainnet (real USDG or USDC) or the testnet, with its per task, per run and daily limits. Key files and <code>~/.brainchain</code> are never read or moved, and raw keys are never written as values. On another computer, create the key file there for a wallet that holds only what the agent may spend. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/brainchain-setups.md">BrainChain setups guide</a>.
      </p>
      <h2>HEY Research setups</h2>
      <p>
        HEY Research Lab is read-only research on Robinhood Chain projects, reached through a hosted or local MCP server. Nomad moves the hosted server (<code>https://heyresearch.xyz/mcp</code>), its research profile and the local server (<code>npx @hey-research-lab/mcp</code> or <code>hey-research-mcp</code>) into the destination&apos;s own format, with the version pin and profile kept. There are no wallets. API keys are never copied, and the preview warns when the local server reads another address than heyresearch.xyz, because its key would be sent there. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/hey-research-setups.md">HEY Research setups guide</a>.
      </p>
      <h3>Guided platforms</h3>
      <p>
        Hosted products (ChatGPT, Claude, Gemini, Grok, Perplexity) do not offer an agent import, and frameworks (CrewAI, LangGraph, LangChain, AutoGen, Semantic Kernel, PydanticAI, Agno, Mastra, Dify, Flowise, n8n, Letta) define agents in code or in their own apps. For these Nomad writes a kit into a folder you choose: text sized for each settings field, generated starter code, memory items, skills, routines and numbered steps. Nothing is sent to those services.
      </p>
    </>
  );
}
