import type { CompatibilityReport } from "@nomad/compatibility";
import { Badge } from "./ui";

export function CompatTable({ report, showEmpty = false }: { report: CompatibilityReport; showEmpty?: boolean }) {
  const rows = report.categories.filter((c) => showEmpty || c.status !== "not-applicable");
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Status</th>
            <th scope="col">Items</th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.category}>
              <td>{c.label}</td>
              <td>
                <Badge kind={c.status}>{c.statusLabel}</Badge>
              </td>
              <td>{c.items || ""}</td>
              <td className="why">{c.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
