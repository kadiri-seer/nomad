import Link from "next/link";
import { REPO_URL } from "@/components/SiteFooter";
import { REWARD_SAFE, REWARD_SAFE_URL, TOKEN_CA, TOKEN_CHAIN, TOKEN_CHART_URL, TOKEN_EXPLORER_URL, TOKEN_HOLDERS_URL, TOKEN_TICKER } from "@/lib/token";

export const metadata = {
  title: "Token and builder bounties",
  description: "What $NOMAD is for: builder bounties for new integrations, minting agents, and fees, buybacks and burns."
};

const PROPOSAL_URL = `${REPO_URL}/issues/new?template=integration-proposal.yml`;
const BOUNTIES_URL = `${REPO_URL}/issues?q=is%3Aissue+in%3Atitle+%22%5BBounty%5D%22`;

const FLYWHEEL = [
  "The community suggests integrations.",
  "Nomad picks the next one.",
  "The treasury funds a builder bounty for it.",
  "Builders develop the integration and pass the tests.",
  "Verified integrations expand what Nomad can move.",
  "More integrations bring more users, more builders and more suggestions."
];

export default function Token() {
  return (
    <>
      <p className="label">Documentation</p>
      <h1>Token and builder bounties</h1>
      <p>
        {TOKEN_TICKER} funds Nomad&apos;s development: the treasury pays the builders who add new integrations, and the token pays for minting agents.
      </p>

      <h2>Token details</h2>
      <ul>
        <li>
          <strong>Ticker:</strong> {TOKEN_TICKER}
        </li>
        <li>
          <strong>Network:</strong> {TOKEN_CHAIN}
        </li>
        <li>
          <strong>Contract address:</strong> <code className="break">{TOKEN_CA}</code> (<a href={TOKEN_EXPLORER_URL}>explorer</a>, <a href={TOKEN_CHART_URL}>chart</a>)
        </li>
        <li>
          <strong>Treasury:</strong> <code className="break">{REWARD_SAFE}</code> (<a href={REWARD_SAFE_URL}>explorer</a>)
        </li>
      </ul>
      <p>Check the contract address against this page before you buy. Tokens with the same name and a different address are not Nomad&apos;s.</p>

      <h2>How it works</h2>
      <ol>
        <li>
          <strong>Integration suggestions.</strong> Anyone can suggest a new agent platform or tool for Nomad to support.
        </li>
        <li>
          <strong>Builder bounties.</strong> Nomad picks the integrations it wants next and posts a bounty for each, paid in {TOKEN_TICKER} from the treasury.
        </li>
        <li>
          <strong>Verification.</strong> Builders submit the integration as a pull request. It is reviewed and must pass Nomad&apos;s adapter contract tests and security checks before it is merged.
        </li>
        <li>
          <strong>Payout.</strong> Once the integration is merged and verified, the builder receives the bounty.
        </li>
        <li>
          <strong>Ecosystem expansion.</strong> Each completed integration makes Nomad useful to more agent builders and users, which brings more suggestions and more work for the community.
        </li>
      </ol>

      <h2>The flywheel</h2>
      <ol className="flywheel">
        {FLYWHEEL.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p>The token gives developers an economic reason to extend Nomad.</p>

      <h2>Taking part</h2>
      <h3>Suggest an integration</h3>
      <p>
        Use the <a href={PROPOSAL_URL}>suggestion form</a> on GitHub: give the app&apos;s name and, if you like, why it should be next.
      </p>
      <h3>Check the payouts</h3>
      <p>
        Every bounty payment comes from the <a href={REWARD_SAFE_URL}>treasury</a>, directly or through Bull&apos;s escrow, and is linked on its <a href={BOUNTIES_URL}>bounty issue</a>, so anyone can confirm who was paid and how much. The <a href={TOKEN_HOLDERS_URL}>holders list</a> is public on the explorer too.
      </p>

      <h2>The treasury</h2>
      <p>
        Bounties are paid from Nomad&apos;s treasury on {TOKEN_CHAIN}. The amount of every bounty is stated when it is posted.
      </p>

      <h2>Fees, buybacks and burns</h2>
      <p>
        {TOKEN_TICKER} also pays for <Link href="/agents">minting an agent</Link> and for copies of minted agents. Part of each mint fee, and part of Nomad&apos;s share of each copy, is burned: sent to the dead address, where no one can move it again. The rest goes to the treasury, and a copy&apos;s price minus Nomad&apos;s share goes to the agent&apos;s owner.
      </p>
      <p>
        When finances permit, the treasury may buy {TOKEN_TICKER} and burn it. Each buyback and burn is sent from the treasury and shown with its transaction on the <Link href="/economy">economy page</Link>, together with the treasury, revenue and Nomad AI&apos;s running costs.
      </p>

      <h2>What the token does not include</h2>
      <p>
        Buybacks, burns and fees can change or stop at any time, and none are promised, on any schedule or in any amount. The token comes with no staking and no share of revenue, and holding it is not a share in Nomad or its income.
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
          Comment on the <a href={BOUNTIES_URL}>bounty issue</a> with the wallet address for your payout, then open the pull request. Continuous integration runs the full test suite on Linux, macOS and Windows; all of it has to pass.
        </li>
      </ul>
      <p>
        See also the <Link href="/docs/adapters">platform matrix</Link> and the <Link href="/docs/security">security model</Link>.
      </p>
    </>
  );
}
