import { Inspector } from "@/components/Inspector";
import { SiteFooter } from "@/components/SiteFooter";

export const metadata = { title: "Package inspector", description: "Open an .agentpack in your browser to check its contents, security and compatibility. Nothing is uploaded." };

export default function InspectPage() {
  return (
    <>
      <main id="main" className="wrap" style={{ padding: "48px 20px 80px" }}>
        <p className="label">Inspector</p>
        <h1 style={{ marginTop: 12, fontSize: "clamp(2rem, 4vw, 3rem)" }}>Look inside an agent package.</h1>
        <p className="lede" style={{ marginTop: 14, marginBottom: 32 }}>
          Nomad validates the archive, checks every file against its recorded hash, scans for secrets and shows how well the agent would fit each platform. It is the same code the app uses.
        </p>
        <Inspector />
      </main>
      <SiteFooter />
    </>
  );
}
