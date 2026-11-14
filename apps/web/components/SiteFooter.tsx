import Link from "next/link";
import { Logo } from "./Logo";
import { XLink } from "./Social";
import { TokenCA } from "./TokenCA";

export const REPO_URL = "https://github.com/kadiri-seer/nomad";

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="footer-grid">
          <div>
            <Link href="/" aria-label="Nomad home" className="brand">
              <Logo markSize={24} />
            </Link>
            <p className="muted" style={{ marginTop: 14, maxWidth: "34ch" }}>
              Portable AI agents. Local first, previewed before every change, backed up after.
            </p>
            <p style={{ marginTop: 14 }}>
              <XLink />
            </p>
            <TokenCA />
          </div>
          <div>
            <h4>Product</h4>
            <ul>
              <li>
                <Link href="/app">Local app</Link>
              </li>
              <li>
                <Link href="/inspect">Package inspector</Link>
              </li>
              <li>
                <Link href="/docs/adapters">Platforms</Link>
              </li>
            </ul>
          </div>
          <div>
            <h4>Docs</h4>
            <ul>
              <li>
                <Link href="/docs">Getting started</Link>
              </li>
              <li>
                <Link href="/docs/format">Agent format</Link>
              </li>
              <li>
                <Link href="/docs/security">Security</Link>
              </li>
              <li>
                <Link href="/docs/token">Token and bounties</Link>
              </li>
            </ul>
          </div>
          <div>
            <h4>Project</h4>
            <ul>
              <li>
                <a href={REPO_URL}>Source code</a>
              </li>
              <li>
                <a href={`${REPO_URL}/issues`}>Questions and issues</a>
              </li>
              <li>
                <Link href="/terms">Terms</Link>
              </li>
              <li>
                <Link href="/privacy">Privacy</Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© {year} Nomad. MIT licensed.</span>
          <span>Your agents never leave your machine unless you send them.</span>
        </div>
      </div>
    </footer>
  );
}
