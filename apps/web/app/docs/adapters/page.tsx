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
      <h2>Rushr setups</h2>
      <p>
        Rushr is a social trading terminal for humans and AI agents on Robinhood Chain, where an agent trades real ETH through a local MCP server that signs with its own wallet. Nomad moves the Rushr server (<code>npx @rushr/mcp</code> or <code>rushr-mcp</code>), the <code>rushr</code> skill and Rushr&apos;s Claude Code and Codex plugin into the destination&apos;s own format, and the preview says whether each server trades for real, with its caps, or is in dry run. <code>~/.rushr</code> and wallet files are never read or moved, and raw keys are never written as values. On another computer, set up a fresh wallet there. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/rushr-setups.md">Rushr setups guide</a>.
      </p>
      <h2>QHooks setups</h2>
      <p>
        QHooks is a launchpad and trading terminal built on Uniswap v4, reached through a hosted MCP server that needs no key and never signs anything: the user&apos;s wallet reviews and signs what it prepares. Nomad moves the server (<code>https://qhooks.com/mcp</code>) into the destination&apos;s own format. At QHooks&apos; request it adds Nomad&apos;s referral: <code>?ref=nomad</code> on an address that names no referral yet, so a user&apos;s own referral is never replaced, and a short <code>qhooks-referral</code> note asking the agent to pass Nomad&apos;s referrer. The preview shows both. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/qhooks-setups.md">QHooks setups guide</a>.
      </p>
      <h2>Tokyo Futuro setups</h2>
      <p>
        Tokyo Futuro is an onchain city game on Robinhood Chain where agents take jobs, join crews and bet, through a hosted MCP server or a local one that signs in with the agent&apos;s wallet. Nomad moves the hosted server, the local server (<code>npx tokyo-futuro-mcp</code>, <code>tokyo-futuro-mcp</code> or <code>node tokyo-mcp.mjs</code>) and the <code>tokyo-futuro</code> skill into the destination&apos;s own format. <code>AGENT_KEY</code>, the agent&apos;s wallet key, is never copied, sign-in tokens are removed from notes and other text, and the preview warns when <code>TOKYO_URL</code> points anywhere other than Tokyo&apos;s own server. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/tokyo-futuro-setups.md">Tokyo Futuro setups guide</a>.
      </p>
      <h2>Ostra setups</h2>
      <p>
        Ostra gives an AI agent its own vault of USDG on Robinhood Chain, guarded by post-quantum one-time keys, through a local MCP server or a hosted connector. Nomad moves the local server (<code>npx @ostraagent/mcp</code> or <code>ostra-mcp</code>) and the connector into the destination&apos;s own format. The vault&apos;s seed (<code>~/.ostra</code> or <code>OSTRA_HOME</code>) and seed backups are never read or copied, and RPC addresses that can carry a provider key become references. The preview says to run Ostra in one app at a time and, for another computer, how to bring the vault along with Ostra&apos;s own encrypted backup. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/ostra-setups.md">Ostra setups guide</a>.
      </p>
      <h2>Stoa setups</h2>
      <p>
        Stoa is a swap router on Robinhood Chain and Elysium, reached through a hosted MCP server that needs no key and never signs anything: it quotes, checks tokens and builds unsigned swaps for the user&apos;s wallet to sign. Nomad moves the server (<code>https://stoadex.com/mcp</code>) and the <code>stoa</code> skill into the destination&apos;s own format, and the preview names Stoa&apos;s router to check before signing. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/stoa-setups.md">Stoa setups guide</a>.
      </p>
      <h2>Zolva setups</h2>
      <p>
        Zolva is open trading-agent infrastructure on Robinhood Chain, reached through a hosted MCP server that is read-only without a key. Nomad moves the server (<code>https://zolvaagent.app/mcp</code>) into the destination&apos;s own format. An optional API key is never copied: the destination reads it from <code>ZOLVA_KEY</code>, and the preview names what the key&apos;s scopes allow. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/zolva-setups.md">Zolva setups guide</a>.
      </p>
      <h2>Memoria setups</h2>
      <p>
        Memoria is a shared memory service for AI agents, reached through a hosted MCP server that needs the agent&apos;s key on every request. Nomad moves the server (<code>https://www.memoriaagent.site/mcp</code>) into the destination&apos;s own format. The key is never copied: the destination reads it from <code>MEMORIA_API_KEY</code>, and the preview explains that the key is the agent&apos;s identity, so the same key keeps the same memories. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/memoria-setups.md">Memoria setups guide</a>.
      </p>
      <h2>Upoch setups</h2>
      <p>
        Upoch saves checkpoints of an agent&apos;s work on Robinhood Chain so it can restore or roll back, through a local MCP server, Upoch Guard. Nomad moves the server (<code>upoch mcp</code> or <code>npx @upoch/guard mcp</code>) into the destination&apos;s own format. Upoch&apos;s folder, which holds its keys, is never read or copied, and the preview says to run the agent in one app at a time and, for another computer, to restore that folder yourself. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/upoch-setups.md">Upoch setups guide</a>.
      </p>
      <h2>OddsEngine setups</h2>
      <p>
        OddsEngine runs crypto safety checks and AI models behind one key, through a hosted MCP server, paid per call. Nomad moves the server (<code>https://api.oddsengine.live/mcp</code>) into the destination&apos;s own format. The key is never copied, also when it was part of the address: the destination reads it from <code>ODDSENGINE_API_KEY</code>. Connect OddsEngine at <a href="https://engine.oddsengine.live/?ref=nomad">engine.oddsengine.live</a>. At OddsEngine&apos;s request, a short skill has the agent end its OddsEngine check results with &quot;Checked by OddsEngine.&quot; The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/oddsengine-setups.md">OddsEngine setups guide</a>.
      </p>
      <h2>Idlex setups</h2>
      <p>
        Idlex runs AI jobs on community GPUs, paid per job in USDG on Robinhood Chain, through a local MCP server, <code>idlex-mcp</code>. Nomad moves the server (<code>node /path/to/idlex-mcp/src/server.ts</code>) into the destination&apos;s own format, with its spend limits. The agent wallet&apos;s key is never copied, and the preview says to put the <code>idlex-mcp</code> folder at the same path on another computer. The details are in the <a href="https://github.com/kadiri-seer/nomad/blob/main/docs/guides/idlex-setups.md">Idlex setups guide</a>.
      </p>
      <h3>Guided platforms</h3>
      <p>
        Hosted products (ChatGPT, Claude, Gemini, Grok, Perplexity) do not offer an agent import, and frameworks (CrewAI, LangGraph, LangChain, AutoGen, Semantic Kernel, PydanticAI, Agno, Mastra, Dify, Flowise, n8n, Letta) define agents in code or in their own apps. For these Nomad writes a kit into a folder you choose: text sized for each settings field, generated starter code, memory items, skills, routines and numbered steps. Nothing is sent to those services.
      </p>
    </>
  );
}
