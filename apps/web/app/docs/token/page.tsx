import Link from "next/link";
import { REPO_URL } from "@/components/SiteFooter";
import { X_HANDLE, X_URL } from "@/components/Social";
import { REWARD_SAFE, REWARD_SAFE_URL, TOKEN_CA, TOKEN_CHAIN, TOKEN_CHART_URL, TOKEN_EXPLORER_URL, TOKEN_HOLDERS_URL, TOKEN_TICKER } from "@/lib/token";

export const metadata = {
  title: "Token and builder bounties",
  description: "How $NOMAD holders choose which integrations Nomad gets next, and how builders are paid for delivering them."
};

const PROPOSAL_URL = `${REPO_URL}/issues/new?template=integration-proposal.yml`;
const BOUNTIES_URL = `${REPO_URL}/issues?q=is%3Aissue+in%3Atitle+%22%5BBounty%5D%22`;

const FLYWHEEL = [
  "The community suggests integrations and token holders vote.",
  "The vote selects the next integration.",
  "The reward wallet funds a builder bounty for it.",
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
        {TOKEN_TICKER} has two jobs: governance and funding development. Holders decide which integrations Nomad gets next, and the reward wallet pays the builders who deliver them. The token coordinates the people deciding what Nomad becomes and the builders making it happen.
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
          <strong>Reward wallet:</strong> <code className="break">{REWARD_SAFE}</code> (<a href={REWARD_SAFE_URL}>explorer</a>)
        </li>
      </ul>
      <p>Check the contract address against this page before you buy. Tokens with the same name and a different address are not Nomad&apos;s.</p>

      <h2>How it works</h2>
      <ol>
        <li>
          <strong>Integration suggestions.</strong> Anyone can suggest a new agent platform or tool for Nomad to support. Suggestions that the maintainers accept as buildable go forward to a vote.
        </li>
        <li>
          <strong>Community voting.</strong> Holders vote on which accepted integration is built next.
        </li>
        <li>
          <strong>Builder bounties.</strong> The winning integration gets a bounty, paid in {TOKEN_TICKER} from the reward wallet.
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
      <p>The token gives the community real influence over Nomad&apos;s development and gives developers an economic reason to extend it.</p>

      <h2>Taking part as a holder</h2>
      <h3>Suggest an integration</h3>
      <p>
        Use the suggestion box on the <Link href="/vote">Vote page</Link>: type the app&apos;s name and, if you like, why it should be next. No account or wallet is needed. You can also back the suggestions already listed there. With a GitHub account you can use the <a href={PROPOSAL_URL}>suggestion form</a> and add a thumbs-up reaction instead; both count.
      </p>
      <h3>Vote</h3>
      <ol>
        <li>
          Open the <Link href="/vote">Vote page</Link> while a round is open. Each new round is also announced on {X_HANDLE}.
        </li>
        <li>Connect the wallet that holds your {TOKEN_TICKER}.</li>
        <li>Pick an option.</li>
        <li>Sign the message to confirm. Voting is free: no transaction is sent, there is no fee, and no tokens leave your wallet.</li>
      </ol>
      <h3>Check the payouts</h3>
      <p>
        Every bounty payment is sent from the <a href={REWARD_SAFE_URL}>reward wallet</a> and linked on its <a href={BOUNTIES_URL}>bounty issue</a>, so anyone can confirm who was paid and how much. The <a href={TOKEN_HOLDERS_URL}>holders list</a> is public on the explorer too.
      </p>

      <h2>Voting rules</h2>
      <ul>
        <li>A round opens every week. Its ballot holds up to five accepted suggestions: the ones with the most backing (backs on the Vote page plus thumbs-up reactions on GitHub). A round needs at least two.</li>
        <li>Each vote stays open for 48 hours.</li>
        <li>One {TOKEN_TICKER} is one vote. Balances are counted at the moment the vote opens, so tokens bought during a vote do not add votes.</li>
        <li>The team&apos;s wallets and the reward wallet do not vote.</li>
        <li>The option with the most votes wins and becomes the next bounty. In a tie, the option with more voting wallets wins; if that is also tied, the older suggestion wins.</li>
        <li>One vote per wallet, and it cannot be changed.</li>
        <li>
          Everything is public: the ballot, the balances taken when the round opened and every signed vote are published in the <a href={`${REPO_URL}/tree/main/governance/rounds`}>repository</a>. When a round closes, every signature is checked again and the votes are recounted before the result is posted.
        </li>
      </ul>

      <h2>The reward wallet</h2>
      <p>
        Bounties are paid from a Safe multisig on {TOKEN_CHAIN}. Sending from it needs two approvals, so no single key can move the funds. Each bounty is funded when it is posted: its amount is moved into the reward wallet and the deposit is linked on the bounty issue. The amount of every bounty is stated when it is posted.
      </p>

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
          Comment on the <a href={BOUNTIES_URL}>bounty issue</a> with the wallet address for your payout, then open the pull request. Continuous integration runs the full test suite on Linux, macOS and Windows; all of it has to pass.
        </li>
      </ul>
      <p>
        See also the <Link href="/docs/adapters">platform matrix</Link> and the <Link href="/docs/security">security model</Link>.
      </p>
    </>
  );
}
