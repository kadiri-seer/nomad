import { SiteFooter, REPO_URL } from "@/components/SiteFooter";

export const metadata = { title: "Privacy Policy", description: "Nomad does not collect your agents or personal data." };

export default function Privacy() {
  return (
    <>
      <main id="main" className="wrap" style={{ padding: "56px 20px 80px" }}>
        <div className="prose">
          <p className="label">Legal</p>
          <h1>Privacy Policy</h1>
          <p className="muted">Last updated 7 November 2026</p>

          <h2>The short version</h2>
          <p>Nomad does not collect, upload or sell your agents, memory, files or personal data. There are no accounts, no analytics and no tracking cookies.</p>

          <h2>The Nomad software</h2>
          <p>
            The command line tool, the local web app and the MCP server run on your computer. They store their library, versions, backups and receipts in <code>~/.nomad</code> (or the folder you set with <code>NOMAD_HOME</code>), readable only by your user account. Nothing in that folder is sent anywhere. The only network use is the optional remote migration command, which connects to a machine you name over SSH.
          </p>

          <h2>This website</h2>
          <p>
            The package inspector reads files you choose inside your browser. They are not uploaded. The local app pages only work when <code>nomad ui</code> runs on your own machine, and use a session cookie limited to that local address. The hosting provider of this website may keep standard server logs such as IP address and request time for security and operations, under its own policy.
          </p>

          <h2>Your rights</h2>
          <p>Because Nomad holds no personal data about you, there is nothing to access, correct or delete on our side. To remove Nomad&apos;s local data, delete the <code>~/.nomad</code> folder.</p>

          <h2>Contact</h2>
          <p>
            Questions: <a href={`${REPO_URL}/issues`}>open an issue on GitHub</a>.
          </p>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
