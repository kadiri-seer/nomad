# NomadAgents

The contract behind minted Nomad agents on Robinhood Chain (`src/NomadAgents.sol`).

- **Minting.** Anyone can mint an agent: a token that records the SHA-256 of its `.nomad` package, its name and a
  link to the package. Minting costs a fee in $NOMAD. Part of the fee is burned (sent to `0x…dEaD`) and the rest goes
  to Nomad's treasury. A package can be minted once.
- **Copies and creator fees.** The agent's owner sets a price in $NOMAD for a copy (0 for free). A buyer pays it
  with `getCopy`; the owner receives the price minus Nomad's platform share, and that share is split between burn
  and treasury. The contract records who has a copy.
- **No funds held.** Every payment goes straight from the payer to its destination. The contract never holds
  tokens or ETH.
- **Limits fixed at deployment.** The owner (Nomad's Safe) can change the mint fee only up to `maxMintFee`, set at
  deployment, and the platform share only up to 20%. It can open or close minting and change the treasury address.
  It cannot change, move or remove anyone's agent or take anyone's tokens. Ownership moves in two steps and cannot
  be given up.
- **Slippage guards.** `mint` takes `maxFee` and `getCopy` takes `maxPrice`, so a fee or price change between
  signing and sending cannot cost the payer more than they agreed to.

The contract has not had an outside audit.

## Settings at deployment (the deploy page's defaults)

| Setting | Default | Can change later |
| --- | --- | --- |
| Owner and treasury | Nomad's Safe, `0xe4862B7605f0CD66796F5d1A9cC936462642b515` | Treasury: yes. Owner: two-step transfer |
| Mint fee | 142,000 $NOMAD ($4.98 on Nov 23, 2026) | Yes, up to the maximum |
| Maximum mint fee | 10,000,000 $NOMAD | No |
| Share of the mint fee burned | 50% | Yes |
| Platform share of a copy's price | 10% | Yes, up to 20% |
| Share of the platform share burned | 50% | Yes |
| Minting | Closed | The Safe opens it |

## Build and test

```bash
cd contracts
npm ci --force   # the test chain lists a macOS-only package; --force lets npm skip it
npm test        # compiles with solc 0.8.28 and runs the tests on a local test chain
```

`npm run build` writes `artifacts/NomadAgents.json` (ABI and bytecode, used by the site) and
`artifacts/NomadAgents.standard-input.json`, the exact compiler input for verifying the deployed contract.

## Deploy

Both contracts (NomadAgents and NomadPaymaster) are deployed together from a maintainer's own computer, with no
browser wallet and no public page:

```
git clone https://github.com/kadiri-seer/nomad
npm ci --prefix nomad/contracts --ignore-scripts
node nomad/contracts/deploy.mjs
```

1. The script makes a fresh deployer wallet (kept in `~/.nomad-deploy`, outside the repo) and asks for 0.0055 ETH on
   Robinhood Chain. It deploys both contracts, owned by Nomad's Safe; minting starts closed. It makes the paymaster's
   signer key and sends it to Vercel (`vercel env add`, sensitive) together with `NEXT_PUBLIC_AGENTS_CONTRACT`,
   `NEXT_PUBLIC_NOMAD_PAYMASTER`, `NEXT_PUBLIC_PRIVY_APP_ID` and `ALCHEMY_RPC_URL` (asked for, hidden). The key is
   never printed and is removed from disk once Vercel has it. Then it funds the deposit (0.005 ETH) and sends what is
   left back to the Safe. Run it again to pick up where it stopped.
2. Verify both on the explorer: on each contract's Blockscout page, choose "Solidity (Standard JSON input)", compiler
   v0.8.28, and upload `artifacts/NomadAgents.standard-input.json` or `artifacts/NomadPaymaster.standard-input.json`. The page shows the constructor arguments to
   paste.
3. Redeploy the site so it picks up the new settings.
4. For encrypted paid copies, set `FILEBASE_IPFS_TOKEN` in Vercel to a Filebase IPFS RPC API key (the same kind
   of key Upoch uses) and redeploy. Without it, creators can still mint with a public link.
5. When you are ready, open minting from the Safe: `node scripts/economy/safe-batch.mjs open-minting` writes a
   batch for the Safe's Transaction Builder (two approvals).

## NomadPaymaster

Pays the gas of Nomad accounts and agents on Robinhood Chain (ERC-4337, EntryPoint v0.7
`0x0000000071727De22E5E9d8BAf0edAc6f37da032`), from a deposit the treasury keeps in the EntryPoint. Nomad's server
signs an operation only when the account has credits to cover it, and charges the cost to those credits with a
margin, so the treasury is repaid. Users never need ETH.

- **Pays only what Nomad signed.** Every operation carries a signature from Nomad's server that covers all its fields
  and expires within minutes. A wrong, reused or expired signature pays nothing.
- **A ceiling per operation.** `maxCostPerOp`, fixed at deployment, caps what any one operation can cost.
- **Money leaves only to the treasury.** The deposit and any stake can be withdrawn to the treasury and nowhere else,
  only by the owner (Nomad's Safe). Renouncing ownership is disabled.
- **Small on purpose.** As an unstaked paymaster must be, it reads no storage while validating. If the signing key ever
  leaked, the most it could cost is the deposit, which is kept small; the owner withdraws it and deploys a new one.

| Setting | Fixed at deployment |
| --- | --- |
| EntryPoint | v0.7 on Robinhood Chain |
| Signer | Nomad's server key (kept as a secret on the server, never in the repo) |
| Treasury | Nomad's Safe |
| maxCostPerOp | 0.0005 ETH suggested (about 100 times a typical trade's gas today) |

Deployed with `contracts/deploy.mjs`, together with NomadAgents (see Deploy above). `/account` opens once the site has
the Privy app id and the paymaster's address.

Tested against the real v0.7 EntryPoint and the reference SimpleAccount (`test/paymaster.test.mjs`): a new account
with no ETH sends a token transfer with its gas paid from the deposit (exactly the operation's cost); a wrong
signer, a signature for another operation, an expired signature and an operation over the ceiling are all refused;
only the EntryPoint can ask it to validate; withdrawals go to the treasury only.

## Agent runner

Agents created from `/account` run on Nomad's site, called every 15 minutes by `.github/workflows/agents.yml` (the site
checks the workflow's GitHub OpenID Connect token, so no secret is stored on GitHub).

- **Wallets.** Each agent has its own Modular Account V2, owned by its creator's Google wallet. When creating the agent
  the creator signs one grant (a deferred action) that installs the runner's session key with the runner's first
  operation. The key can only call `approve` on a token and `swap` on Stoa's router: no transfers, no ETH, no other
  contract, no changes to the wallet. Checked on Robinhood Chain's live contracts by simulation. The creator can
  withdraw everything back to their account, or pause the agent, at any time.
- **Packages.** An account-created agent's package hash is the keccak256 of its set-up (name, template, limits,
  instructions and its wallet), so two agents with the same set-up still mint separately.
- **Rules.** Trades only on Stoa against USDG, only tokens that pass Stoa's safety check (taxes 3% or less, can be
  bought and sold), with at least $20k liquidity and $1,000 traded in 24 hours, at no more than 2% price impact, within
  the agent's per-trade limit and trades a day. It sells at +25%, -20% or after 48 hours.
- **AI.** A Trader asks for a red-flag check before buying; an agent with its own instructions asks what to do, and the
  runner acts only within the checks and limits. Gemini (free tier, set `GEMINI_API_KEY`) answers within the run;
  without it, or when it does not answer, Idlex (qwen2.5-7b) answers by the next run, charged $0.005 a job to the
  creator's credits. Network fees are charged to credits by the paymaster.
- **Switch on.** `node nomad/contracts/setup-runner.mjs` makes `AGENT_RUNNER_SECRET` and adds it to Vercel (every
  session key and the Idlex payer wallet come from it; it is never printed). Fund the Idlex wallet it prints with a
  few USDG, redeploy, then open minting from the Safe.
