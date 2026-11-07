"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const GROUPS: Array<{ label: string; links: Array<{ href: string; label: string }> }> = [
  {
    label: "Agents",
    links: [
      { href: "/app", label: "Overview" },
      { href: "/app/agents", label: "My agents" },
      { href: "/app/versions", label: "Versions" }
    ]
  },
  {
    label: "Move",
    links: [
      { href: "/app/migrate", label: "Migrate" },
      { href: "/app/import", label: "Import" },
      { href: "/app/export", label: "Export" }
    ]
  },
  {
    label: "Records",
    links: [
      { href: "/app/compatibility", label: "Platform compatibility" },
      { href: "/app/history", label: "Migration history" },
      { href: "/app/backups", label: "Backups" },
      { href: "/app/settings", label: "Settings" }
    ]
  }
];

export function AppNav() {
  const p = usePathname();
  const current = (href: string) => (href === "/app" ? p === "/app" : p.startsWith(href));
  return (
    <nav className="app-side" aria-label="Dashboard">
      {GROUPS.map((g) => (
        <div key={g.label} style={{ display: "contents" }}>
          <p className="label group">{g.label}</p>
          {g.links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={current(l.href) ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
