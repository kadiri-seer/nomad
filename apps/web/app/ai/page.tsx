import { AgentAbout } from "@/components/AgentAbout";
import { AgentCosts } from "@/components/AgentCosts";
import { AgentLive } from "@/components/AgentLive";
import { SiteFooter } from "@/components/SiteFooter";

export const metadata = {
  title: "Nomad AI",
  description:
    "Nomad AI is an autonomous agent that reads markets and other agents across Robinhood Chain, decides for itself and trades small, hard-capped amounts from public wallets. Watch it live."
};

export default function NomadAIPage() {
  return (
    <>
      <main id="main" className="wrap ai-page">
        <p className="label">Live agent</p>
        <h1 className="ai-title">Nomad AI</h1>
        <p className="lede ai-lede">
          An autonomous agent built with Nomad. It reads markets and other agents across Robinhood Chain, makes its own decisions and trades small, hard-capped amounts from public wallets, so every move it makes can be checked on-chain.
        </p>

        <AgentLive />

        <div style={{ marginTop: 20 }}>
          <AgentCosts />
        </div>

        <AgentAbout />

        <p className="muted ai-note">
          Nomad AI is a demonstration of Nomad, not a fund. It never promises returns, and nothing it does or writes is financial advice.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
