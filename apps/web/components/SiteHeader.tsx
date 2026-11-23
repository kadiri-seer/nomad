"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";
import { XLink } from "./Social";
import { ThemeToggle } from "./ThemeToggle";

/** The few links people look for first. Everything else sits under More, so the bar stays calm. */
const LINKS = [
  { href: "/#how", label: "How it works" },
  { href: "/ai", label: "Nomad AI" },
  { href: "/economy", label: "Economy" },
  { href: "/docs", label: "Docs" }
];
const MORE = [
  { href: "/docs/adapters", label: "Platforms" },
  { href: "/docs/security", label: "Security" },
  { href: "/vote", label: "Vote" },
  { href: "/inspect", label: "Inspector" }
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    setOpen(false);
    setMore(false);
  }, [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      setMore(false);
    };
    const onClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMore(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, []);
  return (
    <header className="site-header">
      <div className="wrap">
        <Link href="/" className="brand" aria-label="Nomad home">
          <Logo />
        </Link>
        <nav className="nav" aria-label="Main">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={pathname === l.href ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
          <div className="nav-more" ref={moreRef}>
            <button type="button" className="nav-more-button" aria-expanded={more} aria-controls="nav-more-list" onClick={() => setMore((m) => !m)}>
              More
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <div id="nav-more-list" className="nav-more-list" data-open={more}>
              {MORE.map((l) => (
                <Link key={l.href} href={l.href} aria-current={pathname === l.href ? "page" : undefined}>
                  {l.label}
                </Link>
              ))}
              <XLink />
            </div>
          </div>
          <Link href="/app" className="btn nav-cta">
            Open the app
          </Link>
        </nav>
        <ThemeToggle />
        <button className="menu-button" aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "Menu"}
        </button>
      </div>
      <div id="mobile-menu" className="mobile-menu" data-open={open}>
        <nav aria-label="Mobile">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}
          <p className="mobile-menu-label">More</p>
          {MORE.map((l) => (
            <Link key={l.href} href={l.href} className="mobile-menu-small">
              {l.label}
            </Link>
          ))}
          <XLink className="mobile-menu-small" />
          <Link href="/app" className="btn">
            Open the app
          </Link>
        </nav>
      </div>
    </header>
  );
}
