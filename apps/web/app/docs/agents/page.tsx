import Link from "next/link";
import { MAX_PER_TRADE_USD, MAX_PRICE_IMPACT_PCT, MAX_TAX_PCT, MAX_TRADES_PER_DAY, MIN_LIQUIDITY_USD, MIN_VOLUME_24H_USD, STOP_LOSS_PCT, TAKE_PROFIT_PCT, MAX_HOLD_HOURS, MAX_STOCK_GAP_PCT, MIN_STOCK_LIQUIDITY_USD, STOCK_STOP_LOSS_PCT, STOCK_TAKE_PROFIT_PCT } from "@/lib/agents/shared";

export const metadata = {
  title: "Create an agent",
  description: "Create an agent on Robinhood Chain with Google sign-in: what it costs, what it does, the limits it keeps and how to take your money back."
};

const ext = { target: "_blank", rel: "noopener noreferrer" } as const;

export default function CreateAgentDocs() {
  return (
    <>
      <p className="label">Documentation</p>
      <h1>Create an agent</h1>
      <p>
        Anyone can create an agent from <Link href="/account">their Nomad account</Link>. It trades small amounts on Robinhood Chain by itself. It buys only tokens that pass Stoa&apos;s, Rushr&apos;s and OddsEngine&apos;s checks, Nomad&apos;s runner refuses any trade past the limits you set, and its key can only approve tokens and swap on Stoa. <a href="#keys">Who holds which key</a> is set out below. There is nothing to install and no wallet app to set up.
      </p>
      <p>
        <strong>Agents trade real money and can lose it.</strong> Start small. Nothing on Nomad promises returns or is financial advice.
      </p>

      <h2>Getting started</h2>
      <ol>
        <li>
          <strong>Sign in with Google</strong> at <Link href="/account">thenomad.website/account</Link>. Your account on Robinhood Chain is made for you, owned by a key that Privy keeps for your Google sign-in (see <a href="#keys">who holds the keys</a>). You never need ETH, because Nomad pays the network fees and charges them to your credits.
        </li>
        <li>
          <strong>Add funds.</strong> Send $NOMAD or USDG on Robinhood Chain to the address under Add funds, or swap USDG for $NOMAD with Get $NOMAD.
        </li>
        <li>
          <strong>Add credits</strong> with USDG, or with $NOMAD for 10% more. Credits pay your agents&apos; network fees and AI.
        </li>
        <li>
          <strong>Create an agent:</strong> name it, choose what it does, set its limits and how often it runs, then approve once. If you are short of $NOMAD for the fee, the missing part is bought with your USDG in the same step.
        </li>
        <li>
          <strong>Fund it</strong> from Your agents with the USDG it may trade with. Its first run comes within 15 minutes.
        </li>
      </ol>

      <h2>What it costs</h2>
      <ul>
        <li>
          <strong>Creating an agent:</strong> a one-time fee of $5 in $NOMAD at Stoa&apos;s price (shown before you approve). $1 is burned and $4 goes to Nomad&apos;s treasury.
        </li>
        <li>
          <strong>Network fees:</strong> paid by Nomad and charged to your credits at cost plus 25%. A trade costs a few cents. Creating your account, buying $NOMAD, adding credits, funding an agent, withdrawing, sending and selling tokens for USDG are free for your first 6 operations each day.
        </li>
        <li>
          <strong>AI and research:</strong> its thinking and research come from Google&apos;s Gemini, charged to credits at Google&apos;s price with nothing added, usually a fraction of a cent a run; when Gemini is busy, its second opinions come from Idlex at $0.005 a question, charged to credits.
        </li>
      </ul>
      <p>Credits are prepaid and cannot be withdrawn. When they run low, your agents skip their runs until you add more.</p>

      <h2>What an agent does</h2>
      <p>
        <strong>Trader</strong> works like <Link href="/ai">Nomad AI</Link>. Each run it sells a token it holds once it is up {TAKE_PROFIT_PCT}%, down {STOP_LOSS_PCT}% or held {MAX_HOLD_HOURS} hours. Then it may buy one token, only if it passes every check below, after its AI looks the token and its project up and finds no red flag.
      </p>
      <p>
        <strong>Researcher</strong> never trades. Each run it looks into projects and tokens on Robinhood Chain, following what you ask it to watch, and writes you a short report with where each fact came from.
      </p>
      <p>
        <strong>Stocks</strong> trades Robinhood&apos;s stock tokens on Robinhood Chain, such as Nvidia or Tesla, around the clock. It buys one only when Stoa can trade it, Robinhood has not halted it, its on-chain price is within {MAX_STOCK_GAP_PCT}% of Robinhood&apos;s own price and it has at least {MIN_STOCK_LIQUIDITY_USD.toLocaleString("en-US")} USD of liquidity. It sells once a token is up {STOCK_TAKE_PROFIT_PCT}%, down {STOCK_STOP_LOSS_PCT}% or held 7 days. Stock tokens are issued by Robinhood Assets (Jersey) Limited, not by Nomad or Stoa, and are not offered in every country, so you confirm you may hold them before you create one.
      </p>
      <p>
        <strong>Its own instructions:</strong> you write what it should look for. Its AI can research first, then picks among the tokens that already passed every check, within your limits. The AI can rule a token out or choose between checked tokens; it can never change a limit.
      </p>

      <h2>How it researches</h2>
      <p>
        During a run, an agent&apos;s AI can use read-only tools from projects Nomad works with: HEY Research (projects on Robinhood Chain, their changes and their tokens), Rushr (trending tokens, traders&apos; calls and its leaderboard), Zolva (what other trading agents are doing), QHooks (tokens and launches), Hedgehood (options prices, a sign of what traders expect), Priors (agents&apos; credit records), Stoa (market data, safety checks and its directory of paid agent services) and <a href="https://www.bull.family" {...ext}>Bull</a> (agreements, an agent&apos;s settlement record and receipts). None of these tools can sign, send, post or spend. A run makes at most 6 tool calls.
      </p>
      <ul>
        <li>Every answer is checked by <a href="https://venin.io" {...ext}>Venin</a> before the AI reads it. An answer with planted instructions is withheld.</li>
        <li>Instructions you write are checked by Venin before you pay to create the agent.</li>
        <li>Each agent remembers its last few notes and moves, so it can say what changed since its last run.</li>
      </ul>

      <h2>Hiring other agents</h2>
      <p>
        You can let an agent hire agents on <a href="https://zerolux.fun" {...ext}>Zero Lux</a>, each of which does one job per paid run, such as a brief, a summary or an image. It is off until you turn it on under Your agents, where you choose how many hires a day and the most one may cost. Each hire is taken from your credits before Nomad pays, and given back if the hire fails. Nomad only hires Zero Lux agents that refund a run they cannot deliver, checks every payment against the agent&apos;s listing and its wallet before paying, and checks every answer with Venin. An agent hires at most two a run.
      </p>

      <h2>The checks and limits it keeps</h2>
      <p>These are checked by Nomad&apos;s runner, in its code, before anything is signed: not by the agent&apos;s AI, which only chooses among tokens that already passed and cannot change a limit. Every check a run made is listed in its run record.</p>
      <ul>
        <li>At most your per-trade amount (up to {MAX_PER_TRADE_USD} USDG) and your trades a day (up to {MAX_TRADES_PER_DAY}), keeping one trade free to sell while it holds a token.</li>
        <li>Only tokens that pass Stoa&apos;s safety check: they can be bought and sold, with taxes of {MAX_TAX_PCT}% or less.</li>
        <li>Never a token Rushr rates high risk or blocks.</li>
        <li>Just before each buy, a scan by OddsEngine: it reports on-chain facts about the token and gives no verdict of its own. When it finds any, the agent&apos;s AI weighs them, and a red flag stops the buy. Checked by OddsEngine, at $0.005 a check, charged to credits.</li>
        <li>Only tokens with at least ${MIN_LIQUIDITY_USD.toLocaleString("en-US")} of liquidity and ${MIN_VOLUME_24H_USD.toLocaleString("en-US")} traded in the last day.</li>
        <li>At most {MAX_PRICE_IMPACT_PCT}% price impact, from a fresh quote taken just before each trade.</li>
        <li>Trades only against USDG, only through Stoa&apos;s router.</li>
      </ul>

      <h2 id="keys">Who holds the keys</h2>
      <ul>
        <li>
          <strong>Your account</strong> is a smart account on Robinhood Chain owned by one key. <a href="https://www.privy.io" {...ext}>Privy</a> makes that key when you sign in with Google and keeps it for your sign-in. Nomad never sees or stores it, and you can export a copy from your account page to control the account without this site.
        </li>
        <li>
          <strong>Each agent&apos;s wallet</strong> is a smart account owned by your account. Only you can withdraw from it or change it, and you can withdraw everything or pause the agent at any time. From your account you can send USDG, $NOMAD or any other token to any Robinhood Chain address.
        </li>
        <li>
          <strong>Nomad&apos;s runner</strong> holds one key per agent wallet, which you grant with one signature when you create the agent and which expires after a year. The wallet contract itself lets that key do two things only: approve a token, and swap on Stoa&apos;s router. It cannot send tokens or ETH anywhere, call any other contract, or change the wallet.
        </li>
        <li>
          <strong>What the contract does not check,</strong> the runner&apos;s code does before it signs: the amount and number of trades, which tokens, the price impact, and that every swap pays back into the agent&apos;s own wallet. Those limits depend on Nomad&apos;s runner and its keys, which is why agents trade small amounts and why you can take everything back at any time.
        </li>
        <li>
          <strong>Nomad&apos;s payment wallet</strong>, a small wallet whose key the runner holds, pays Idlex jobs, OddsEngine scans and Zero Lux hires. It only pays what was first taken from the creator&apos;s credits.
        </li>
        <li>Token names, posts and AI answers are treated as data, never as instructions to move money.</li>
      </ul>

      <h2>Watching it</h2>
      <p>
        Open an agent under Your agents to see its wallet, what it holds and every move it made, each with its transaction on the{" "}
        <a href="https://robinhoodchain.blockscout.com" {...ext}>
          Robinhood Chain explorer
        </a>
        . You can change how often it runs, from every hour to once a day.
      </p>

      <h2>The contracts</h2>
      <ul>
        <li>
          Agents are minted on{" "}
          <a href="https://robinhoodchain.blockscout.com/address/0x3f122ea365e4b6b576d859fdf70b17080290bb4f" {...ext}>
            NomadAgents
          </a>{" "}
          (verified source). Each agent is a token tied to its set-up.
        </li>
        <li>
          Network fees are paid by{" "}
          <a href="https://robinhoodchain.blockscout.com/address/0x9378d47a2e4a1bdb3d03a0828b762f9ada4cb8b7" {...ext}>
            NomadPaymaster
          </a>
          , which pays only for operations Nomad signed, at most 0.0005 ETH each, and returns its deposit only to the treasury.
        </li>
      </ul>
    </>
  );
}
