import type { Metadata, Viewport } from "next";
import "@fontsource-variable/schibsted-grotesk";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = {
  title: { default: "Nomad: move AI agents between platforms", template: "%s | Nomad" },
  description:
    "Nomad moves AI agents between OpenClaw, Claude Code, Codex, Hermes and more. It preserves identity, memory and skills, previews every change and keeps backups.",
  applicationName: "Nomad",
  openGraph: {
    title: "Nomad: move AI agents between platforms",
    description: "Portable AI agents with previews, backups and honest compatibility reports.",
    type: "website"
  }
};

export const viewport: Viewport = {
  themeColor: "#efede6",
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
