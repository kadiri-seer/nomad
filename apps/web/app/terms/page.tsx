import { SiteFooter, CONTACT_EMAIL } from "@/components/SiteFooter";

export const metadata = { title: "Terms of Service", description: "Terms for using the Nomad software and website." };

export default function Terms() {
  return (
    <>
      <main id="main" className="wrap" style={{ padding: "56px 20px 80px" }}>
        <div className="prose">
          <p className="label">Legal</p>
          <h1>Terms of Service</h1>
          <p className="muted">Last updated 7 November 2026</p>

          <h2>What Nomad is</h2>
          <p>Nomad is open source software that reads, converts and writes AI agent configuration files on your own computer. This website describes the software and offers a package inspector that runs entirely in your browser.</p>

          <h2>License</h2>
          <p>The software is provided under the MIT License. You may use, copy, modify and distribute it under the terms of that license, which is included in the source repository.</p>

          <h2>Your responsibility</h2>
          <p>
            You decide what Nomad reads and where it writes. Review each migration preview before applying it, keep your own backups of anything important, and make sure you have the right to move the agents, memory and files you work with. Using an agent on another platform is subject to that platform&apos;s own terms.
          </p>

          <h2>No warranty</h2>
          <p>
            The software is provided &quot;as is&quot;, without warranty of any kind. Nomad takes backups and verifies its writes, but configuration formats of third party platforms change, and some features are labelled experimental or guided for that reason. To the extent permitted by law, the authors are not liable for any loss arising from the use of the software or this website.
          </p>

          <h2>Third party names</h2>
          <p>Names of platforms such as OpenClaw, Claude Code, Codex, Hermes, Cursor and others are used only to describe compatibility. Nomad is not affiliated with or endorsed by those projects or companies.</p>

          <h2>Changes</h2>
          <p>These terms may be updated. The date above shows the latest version.</p>

          <h2>Contact</h2>
          <p>
            Questions: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </p>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
