import { ALL_INFOS } from "@nomad/adapters/catalog";
import { SUPPORT_DESCRIPTIONS, SUPPORT_LABELS } from "@nomad/core";
import { CATEGORY_LABELS } from "@nomad/compatibility";
import { COMPONENT_CATEGORIES } from "@nomad/schema";
import { Badge } from "@/components/ui";

export const metadata = { title: "Platforms", description: "What Nomad can read and write on each platform, category by category." };

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
      <h3>Guided platforms</h3>
      <p>
        Hosted products (ChatGPT, Claude, Gemini, Grok, Perplexity) do not offer an agent import, and frameworks (CrewAI, LangGraph, LangChain, AutoGen, Semantic Kernel, PydanticAI, Agno, Mastra, Dify, Flowise, n8n, Letta) define agents in code or in their own apps. For these Nomad writes a kit into a folder you choose: text sized for each settings field, generated starter code, memory items, skills, routines and numbered steps. Nothing is sent to those services.
      </p>
    </>
  );
}
