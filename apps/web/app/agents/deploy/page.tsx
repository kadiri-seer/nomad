import { AgentsDeploy } from "@/components/AgentsDeploy";
import { PaymasterDeploy } from "@/components/PaymasterDeploy";
import { SiteFooter } from "@/components/SiteFooter";

export const metadata = {
  title: "Deploy the agents contracts",
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
        <h2 className="ai-title" style={{ fontSize: "1.6rem", marginTop: 48 }}>Deploy the paymaster</h2>
        <p className="lede ai-lede">
          NomadPaymaster pays the network fees of Nomad accounts from a small deposit, and the site charges them back to each account&apos;s credits. Your wallet pays the gas to deploy and the deposit; the owner and treasury are Nomad&apos;s Safe.
        </p>
        <PaymasterDeploy />
      </main>
      <SiteFooter />
    </>
  );
}
