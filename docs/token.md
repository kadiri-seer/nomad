# Token and builder bounties

$NOMAD has two jobs: governance and funding development. Holders decide which integrations Nomad gets next, and the reward wallet pays the builders who deliver them. The token coordinates the people deciding what Nomad becomes and the builders making it happen.

## Token details

- **Ticker:** $NOMAD
- **Network:** Robinhood Chain
- **Contract address:** `0x14c0a77e792f6c9818888630e95c50cf3b48c979` ([explorer](https://robinhoodchain.blockscout.com/token/0x14c0a77e792f6c9818888630e95c50cf3b48c979), [chart](https://dexscreener.com/robinhood/0x14c0a77e792f6c9818888630e95c50cf3b48c979))
- **Reward wallet:** `0xe4862B7605f0CD66796F5d1A9cC936462642b515` ([explorer](https://robinhoodchain.blockscout.com/address/0xe4862B7605f0CD66796F5d1A9cC936462642b515))

Check the contract address against this page before you buy. Tokens with the same name and a different address are not Nomad's.

## How it works

1. **Integration suggestions.** Anyone can suggest a new agent platform or tool for Nomad to support. Suggestions that the maintainers accept as buildable go forward to a vote.
2. **Community voting.** Holders vote on which accepted integration is built next.
3. **Builder bounties.** The winning integration gets a bounty, paid in $NOMAD from the reward wallet.
4. **Verification.** Builders submit the integration as a pull request. It is reviewed and must pass Nomad's adapter contract tests and security checks before it is merged.
5. **Payout.** Once the integration is merged and verified, the builder receives the bounty.
6. **Ecosystem expansion.** Each completed integration makes Nomad useful to more agent builders and users, which brings more suggestions and more work for the community.

## The flywheel

1. The community suggests integrations and token holders vote.
2. The vote selects the next integration.
3. The reward wallet funds a builder bounty for it.
4. Builders develop the integration and pass the tests.
5. Verified integrations expand what Nomad can move.
6. More integrations bring more users, more builders and more suggestions.

## Taking part as a holder

### Suggest an integration

Reply to the pinned post on [@thenomadlabs](https://x.com/thenomadlabs) with the app you want Nomad to support. With a GitHub account you can also use the [suggestion form](https://github.com/kadiri-seer/nomad/issues/new?template=integration-proposal.yml).

### Vote

1. Open the vote link posted on @thenomadlabs. Votes run on [Snapshot](https://snapshot.box).
2. Connect the wallet that holds your $NOMAD.
3. Pick an option.
4. Sign the message to confirm. Voting is free: there is no fee, and no tokens leave your wallet.

### Check the payouts

Every bounty payment is sent from the reward wallet and linked on its [bounty issue](https://github.com/kadiri-seer/nomad/issues?q=is%3Aissue+in%3Atitle+%22%5BBounty%5D%22), so anyone can confirm who was paid and how much. The [holders list](https://robinhoodchain.blockscout.com/token/0x14c0a77e792f6c9818888630e95c50cf3b48c979?tab=holders) is public on the explorer too.

## Voting rules

- A vote runs every two weeks, with three to five accepted suggestions on the ballot.
- Each vote stays open for about three days.
- One $NOMAD is one vote. Balances are counted at the moment the vote opens, so tokens bought during a vote do not add votes.
- The team's wallets and the reward wallet do not vote.
- The option with the most votes wins and becomes the next bounty.

## The reward wallet

Bounties are paid from a Safe multisig on Robinhood Chain. Sending from it needs two approvals, so no single key can move the funds. Each bounty is funded when it is posted: its amount is moved into the reward wallet and the deposit is linked on the bounty issue. The amount of every bounty is stated when it is posted.

## What the token does not include

The token comes with no buybacks, no staking and no share of revenue, and none are promised. Holding it gives a vote on Nomad's roadmap and nothing else.

## Building an integration for a bounty

An integration is an adapter: code that reads an agent from a platform and writes one back.

- Follow [Building an adapter](adapters/building-an-adapter.md) and declare honestly what the platform can and cannot hold.
- Run the adapter contract (`runAdapterContract` from `@nomad/sdk`) against a realistic fixture of the platform: detection, reading without side effects, writing through the engine, verification, and idempotent re-writes.
- Plant fake keys in your fixture and pass them as `secrets`. The contract fails if any of them appears in a plan, a receipt or a written file. Wallet folders and key files must never be read.
- Comment on the bounty issue with the wallet address for your payout, then open the pull request. CI runs the full suite on Linux, macOS and Windows; all of it has to pass.
