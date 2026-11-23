import { AgentsDeploy } from "@/components/AgentsDeploy";
import { SiteFooter } from "@/components/SiteFooter";

export const metadata = {
  title: "Deploy the agents contract",
  robots: { index: false, follow: false }
};

export default function AgentsDeployPage() {
  return (
    <>
      <main id="main" className="wrap ai-page">
        <p className="label">Maintainers</p>
        <h1 className="ai-title">Deploy the agents contract</h1>
        <p className="lede ai-lede">
          Deploys NomadAgents to Robinhood Chain from your wallet. Your wallet pays the gas; the owner and treasury are the addresses below (Nomad&apos;s Safe), not your wallet. Minting starts closed. See contracts/README.md for the steps after this.
        </p>
        <AgentsDeploy />
      </main>
      <SiteFooter />
    </>
  );
}
