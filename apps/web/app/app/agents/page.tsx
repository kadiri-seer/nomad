"use client";

import Link from "next/link";
import { useApi } from "@/lib/client";
import { Badge, Empty, Notice, PageHead, Skeleton, formatDate } from "@/components/ui";

export default function Agents() {
  const { data, error, loading } = useApi<any[]>("agents");
  return (
    <>
      <PageHead title="My agents" sub="Every agent Nomad has read, imported or created, with where it currently lives.">
        <Link href="/app/import" className="btn btn-quiet">
          Import a package
        </Link>
      </PageHead>
      {error && <Notice tone="bad">{error.message}</Notice>}
      {loading && !data ? (
        <Skeleton rows={5} />
      ) : !data?.length ? (
        <Empty title="Your library is empty">
          Add agents from the <Link href="/app">Overview</Link> scan, or <Link href="/app/import">import a package</Link>.
        </Empty>
      ) : (
        <div className="panel table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Original platform</th>
                <th scope="col">Current locations</th>
                <th scope="col">Version</th>
                <th scope="col">Skills</th>
                <th scope="col">Memory</th>
                <th scope="col">Last updated</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link href={`/app/agents/${a.id}`} style={{ fontWeight: 600 }}>
                      {a.name}
                    </Link>
                    {a.description && (
                      <div className="muted" style={{ fontSize: "0.85rem" }}>
                        {a.description}
                      </div>
                    )}
                  </td>
                  <td>{a.sourcePlatform}</td>
                  <td>
                    <div className="tag-list">
                      {a.locations.length ? a.locations.map((l: any) => <Badge key={l.id} kind={l.role === "primary" ? "info" : "neutral"}>{l.adapter}</Badge>) : <span className="muted">Library only</span>}
                    </div>
                  </td>
                  <td>v{a.currentVersion}</td>
                  <td>{a.skills}</td>
                  <td>{a.memoryEntries ? `${a.memoryEntries} entries` : <span className="muted">None</span>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{formatDate(a.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
