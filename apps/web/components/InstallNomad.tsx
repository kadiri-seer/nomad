"use client";

import { useEffect, useState } from "react";

type System = "windows" | "mac" | "linux";

const SYSTEMS: Record<System, { label: string; open: string; command: string; script: string; after: string }> = {
  windows: {
    label: "Windows",
    open: "Press Start, type PowerShell and open it. Paste this line and press Enter.",
    command: "irm https://www.thenomad.website/install.ps1 | iex",
    script: "/install.ps1",
    after: "After that, open Nomad from the Start menu like any app."
  },
  mac: {
    label: "Mac",
    open: "Open Terminal (press Command and Space, then type Terminal). Paste this line and press Enter.",
    command: "curl -fsSL https://www.thenomad.website/install.sh | sh",
    script: "/install.sh",
    after: "After that, open Nomad from Applications or Launchpad like any app."
  },
  linux: {
    label: "Linux",
    open: "Open a terminal. Paste this line and press Enter.",
    command: "curl -fsSL https://www.thenomad.website/install.sh | sh",
    script: "/install.sh",
    after: "After that, open Nomad from your apps menu."
  }
};

function detect(): System | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = `${nav.userAgentData?.platform ?? ""} ${navigator.platform ?? ""} ${navigator.userAgent}`;
  if (/android|iphone|ipad/i.test(p)) return null;
  if (/win/i.test(p)) return "windows";
  if (/mac/i.test(p)) return "mac";
  if (/linux|x11|cros/i.test(p)) return "linux";
  return null;
}

/** The one-line installer for the visitor's system, with a Copy button. */
export function InstallNomad() {
  const [system, setSystem] = useState<System>("windows");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const found = detect();
    if (found) setSystem(found);
  }, []);
  const s = SYSTEMS[system];

  async function copy() {
    try {
      await navigator.clipboard.writeText(s.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="install">
      <div className="install-tabs" role="tablist" aria-label="Your system">
        {(Object.keys(SYSTEMS) as System[]).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={k === system}
            onClick={() => {
              setSystem(k);
              setCopied(false);
            }}
          >
            {SYSTEMS[k].label}
          </button>
        ))}
      </div>
      <p className="install-step">{s.open}</p>
      <div className="install-cmd">
        <code>{s.command}</code>
        <button type="button" className="btn btn-lime btn-sm" onClick={copy} aria-label={`Copy the ${s.label} install line`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="install-step">{s.after}</p>
      <p className="install-note">
        <a href={s.script}>Read the script first</a>. It downloads Nomad from the project&apos;s GitHub releases, checks it against its published fingerprint, and installs it in your user folder. Remove it any time with <code>nomad uninstall</code>.
      </p>
      <span className="sr-only" aria-live="polite">
        {copied ? "Install line copied" : ""}
      </span>
    </div>
  );
}
