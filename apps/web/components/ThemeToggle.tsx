"use client";

import { THEME_KEY } from "@/lib/theme";

function current(): "light" | "dark" {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Switches between light and dark mode and remembers the choice. Without a choice, the device's setting is used. */
export function ThemeToggle() {
  const toggle = () => {
    const next = current() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: the choice lasts for this page */
    }
  };
  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label="Switch between light and dark mode" title="Light or dark mode">
      <svg className="icon-moon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
      <svg className="icon-sun" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
        </g>
      </svg>
    </button>
  );
}
