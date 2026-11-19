import type { Metadata, Viewport } from "next";
import "@fontsource-variable/schibsted-grotesk";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";
import { THEME_SCRIPT } from "@/lib/theme";

// Absolute URLs for link previews. Vercel provides the production host; NEXT_PUBLIC_SITE_URL overrides it (for a custom domain).
const site = process.env.NEXT_PUBLIC_SITE_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://127.0.0.1:4317");

export const metadata: Metadata = {
  metadataBase: new URL(site),
  title: { default: "Nomad: move AI agents between platforms", template: "%s | Nomad" },
  description:
    "Nomad moves AI agents between OpenClaw, Claude Code, Codex, Hermes and more. It preserves identity, memory and skills, previews every change and keeps backups.",
  applicationName: "Nomad",
  openGraph: {
    title: "Nomad: move AI agents between platforms",
    description: "Portable AI agents with previews, backups and honest compatibility reports.",
    type: "website"
  },
  twitter: { card: "summary", site: "@thenomadlabs", creator: "@thenomadlabs" }
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#efede6" },
    { media: "(prefers-color-scheme: dark)", color: "#141412" }
  ],
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
