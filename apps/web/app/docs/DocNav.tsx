"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/docs", label: "Getting started" },
  { href: "/docs/format", label: "Agent format" },
  { href: "/docs/adapters", label: "Platforms" },
  { href: "/docs/security", label: "Security" }
];

export function DocNav() {
  const p = usePathname();
  return (
    <nav className="doc-nav" aria-label="Documentation">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={p === l.href ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
