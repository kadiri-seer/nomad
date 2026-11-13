import Link from "next/link";
import { REPO_URL } from "@/components/SiteFooter";

export const metadata = {
  title: "Token and builder bounties",
  description: "How Nomad's token coordinates which integrations get built next and funds the builders who make them."
};

const FLYWHEEL = [
  "The community proposes integrations and token holders vote.",
  "The vote selects the next integration.",
  "The treasury funds a builder bounty for it.",
  "Builders develop the integration and pass the tests.",
  "Verified integrations expand what Nomad can move.",
  "More integrations bring more users, more builders and more proposals."
];

export default function Token() {
  return (
    <>
      <p className="label">Documentation</p>
      <h1>Token and builder bounties</h1>
      <p>
        Nomad&apos;s token has two jobs: governance and funding development. Token holders decide which integrations Nomad gets next, and the treasury pays the builders who deliver them. The token coordinates the people deciding what Nomad becomes and the builders making it happen.
      </p>

      <h2>How it works</h2>
      <ol>
        <li>
          <strong>Integration proposals.</strong> Anyone can propose a new agent platform or tool for Nomad to support. Proposals that the maintainers accept as buildable go forward to a vote.
        </li>
        <li>
          <strong>Community voting.</strong> Token holders vote on which accepted integration is built next.
        </li>
        <li>
          <strong>Builder bounties.</strong> The treasury funds a bounty, paid in tokens, for the winning integration.
        </li>
        <li>
          <strong>Verification.</strong> Builders submit the integration as a pull request. It is reviewed and must pass Nomad&apos;s adapter contract tests and security checks before it is merged.
        </li>
        <li>
          <strong>Treasury payout.</strong> Once the integration is merged and verified, the builder receives the bounty.
        </li>
        <li>
          <strong>Ecosystem expansion.</strong> Each completed integration makes Nomad useful to more agent builders and users, which brings more proposals and more work for the community.
        </li>
      </ol>

      <h2>The flywheel</h2>
      <ol className="flywheel">
        {FLYWHEEL.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p>The token gives the community real influence over Nomad&apos;s development and gives developers an economic reason to extend it.</p>

      <h2>What the token does not include</h2>
      <p>
        The token comes with no buybacks, no staking and no share of revenue, and none are promised. Holding it gives a vote on Nomad&apos;s roadmap and nothing else.
      </p>

      <h2>Building an integration for a bounty</h2>
      <p>An integration is an adapter: code that reads an agent from a platform and writes one back. The checks a bounty submission must pass are the same ones every adapter in Nomad already passes.</p>
      <ul>
        <li>
          Follow the <a href={`${REPO_URL}/blob/main/docs/adapters/building-an-adapter.md`}>adapter guide</a> and declare honestly what the platform can and cannot hold. Labels come from those declarations; nothing is labelled full unless it is.
        </li>
        <li>
          Run the adapter contract (<code>runAdapterContract</code> from <code>@nomad/sdk</code>) against a realistic fixture of the platform. It checks detection, reading without side effects, writing through Nomad&apos;s engine, verification and that writing twice changes nothing.
        </li>
        <li>
          Plant fake keys in your fixture and pass them to the contract. It fails if any of them appears in a plan, a receipt or a written file. Wallet folders and key files must never be read.
        </li>
        <li>
          Open the pull request. Continuous integration runs the full test suite on Linux, macOS and Windows; all of it has to pass.
        </li>
      </ul>
      <p>
        See also the <Link href="/docs/adapters">platform matrix</Link> and the <Link href="/docs/security">security model</Link>.
      </p>
    </>
  );
}
