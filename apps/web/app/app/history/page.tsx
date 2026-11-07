"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, useApi } from "@/lib/client";
import { ReceiptView } from "@/components/MigrationWizard";
import { Badge, Empty, Notice, PageHead, Skeleton, formatDate } from "@/components/ui";

function History() {
  const params = useSearchParams();
  const list = useApi<any[]>("history");
  const [op, setOp] = useState<string | null>(params.get("op"));
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!op) return;
    setDetail(null);
    api(`operations/${op}`)
      .then(setDetail)
      .catch((e) => setError(e.message));
  }, [op]);

  return (
    <>
      {error && <Notice tone="bad">{error}</Notice>}
      {list.loading && !list.data ? (
        <Skeleton rows={5} />
      ) : !list.data?.length ? (
        <Empty title="No operations yet">Every migration, import, export and restore is recorded here with a receipt.</Empty>
      ) : (
        <div className="panel table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Operation</th>
                <th scope="col">Agent</th>
                <th scope="col">Source</th>
                <th scope="col">Destination</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((o) => (
                <tr key={o.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{formatDate(o.createdAt)}</td>
                  <td>
                    <button className="link-btn" onClick={() => setOp(o.id)}>
                      {o.kind}
                    </button>
                  </td>
                  <td>{o.receiptJson?.agent?.name}</td>
                  <td className="break">{o.source}</td>
                  <td className="break">{o.destination}</td>
                  <td>
                    <Badge kind={o.status}>{o.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {op && (
        <div style={{ marginTop: 24 }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <h2 style={{ fontSize: "1.3rem" }}>Receipt {op}</h2>
            <button className="btn btn-quiet btn-sm" onClick={() => setOp(null)}>
              Close
            </button>
          </div>
          {!detail ? (
            <Skeleton rows={4} />
          ) : detail.receiptJson?.verification ? (
            <ReceiptView receipt={detail.receiptJson} />
          ) : (
            <pre className="code">{JSON.stringify(detail.receiptJson, null, 2)}</pre>
          )}
        </div>
      )}
    </>
  );
}

export default function HistoryPage() {
  return (
    <>
      <PageHead title="Migration history" sub="What happened, when, and what it changed." />
      <Suspense fallback={<Skeleton rows={5} />}>
        <History />
      </Suspense>
    </>
  );
}
