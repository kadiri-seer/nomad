import Link from "next/link";
import { EconomyLive } from "@/components/EconomyLive";
import { SiteFooter } from "@/components/SiteFooter";

export const metadata = {
  title: "Economy",
  description: "Nomad's treasury, revenue, Nomad AI's running costs, builder bounties, buybacks and burns, and minted agents, read live from Robinhood Chain."
};

const FLOW = [
  { n: "01", title: "Revenue comes in", text: "Referral shares from integrations, and fees from minted agents, go to Nomad's wallets." },
  { n: "02", title: "Nomad AI runs on a budget", text: "Its AI, safety checks and network fees are counted after every run, against a monthly budget." },
  { n: "03", title: "Bounties pay builders", text: "Integrations that win a holder vote get a bounty in $NOMAD from the treasury." },
  { n: "04", title: "Agents are minted", text: "Creators mint agents for a fee in $NOMAD and set a price for copies; part of each fee is burned." },
  { n: "05", title: "Buybacks and burns", text: "When finances permit, the treasury buys $NOMAD and burns it. None are promised." }
];

export default function EconomyPage() {
  return (
    <>
      <main id="main" className="wrap ai-page">
        <p className="label">Economy</p>
        <h1 className="ai-title">Where the money goes</h1>
        <p className="lede ai-lede">
          Every number here is read live from Robinhood Chain or from a public record, so anyone can check it. Nothing is estimated or projected.
        </p>

        <ol className="ai-steps eco-flow">
          {FLOW.map((s) => (
            <li key={s.n}>
              <span className="num">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>

        <EconomyLive />

        <p className="muted ai-note">
          Buybacks, burns and fees can change or stop, and none are promised. Holding $NOMAD is not a share in Nomad or its income, and nothing on this page is financial advice. Read <Link href="/docs/token">how the token works</Link>.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
