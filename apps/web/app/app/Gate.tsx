"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Skeleton } from "@/components/ui";

type State = "checking" | "ok" | "offline" | "expired";

/**
 * The dashboard pages are static. Whether they show anything depends on the
 * local API answering for this browser's session; the API itself enforces the
 * session, host and origin checks.
 */
export function Gate({ children, offline, expired }: { children: ReactNode; offline: ReactNode; expired: ReactNode }) {
  const [state, setState] = useState<State>("checking");
  useEffect(() => {
    let live = true;
    fetch("/api/local/session", { credentials: "same-origin", cache: "no-store" })
      .then((r) => live && setState(r.ok ? "ok" : r.status === 401 ? "expired" : "offline"))
      .catch(() => live && setState("offline"));
    return () => {
      live = false;
    };
  }, []);
  if (state === "ok") return <>{children}</>;
  if (state === "expired") return <>{expired}</>;
  if (state === "offline") return <>{offline}</>;
  return (
    <main id="main" className="wrap" style={{ padding: "72px 20px 96px" }} aria-busy="true">
      <Skeleton rows={4} />
    </main>
  );
}
