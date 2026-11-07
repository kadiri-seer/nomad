"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApi } from "@/lib/client";
import { VersionCompare } from "@/components/VersionCompare";
import { Empty, Notice, PageHead, Skeleton } from "@/components/ui";

export default function VersionsPage() {
  const agents = useApi<any[]>("agents");
  const [agentId, setAgentId] = useState("");
  const detail = useApi(agentId ? `agents/${agentId}` : null);
  useEffect(() => {
    if (!agentId && agents.data?.length) setAgentId(agents.data[0].id);
  }, [agents.data, agentId]);

  return (
    <>
      <PageHead title="Versions" sub="Nomad keeps a version every time an agent's content changes, and none when it does not." />
      {agents.loading && !agents.data ? (
        <Skeleton rows={4} />
      ) : !agents.data?.length ? (
        <Empty title="No agents yet">Versions appear once you add an agent to the library.</Empty>
      ) : (
        <div className="stack">
          <label className="field" style={{ maxWidth: 360 }}>
            <span>Agent</span>
            <select className="select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.data.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} (v{a.currentVersion})
                </option>
              ))}
            </select>
          </label>
          {detail.error && <Notice tone="bad">{detail.error.message}</Notice>}
          {detail.loading || !detail.data ? (
            <Skeleton rows={3} />
          ) : (
            <>
              <VersionCompare key={agentId} agentId={agentId} versions={detail.data.versions} current={detail.data.agent.currentVersion} onRestored={detail.reload} />
              <p>
                <Link href={`/app/agents/${agentId}`}>Open {detail.data.agent.name}</Link>
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}
