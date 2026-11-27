# Token and builder bounties

$NOMAD funds Nomad's development: the treasury pays the builders who add new integrations, and the token pays for minting agents.

## Token details

- **Ticker:** $NOMAD
- **Network:** Robinhood Chain
- **Contract address:** `0x14c0a77e792f6c9818888630e95c50cf3b48c979` ([explorer](https://robinhoodchain.blockscout.com/token/0x14c0a77e792f6c9818888630e95c50cf3b48c979), [chart](https://dexscreener.com/robinhood/0x14c0a77e792f6c9818888630e95c50cf3b48c979))
- **Treasury:** `0xe4862B7605f0CD66796F5d1A9cC936462642b515` ([explorer](https://robinhoodchain.blockscout.com/address/0xe4862B7605f0CD66796F5d1A9cC936462642b515))

Check the contract address against this page before you buy. Tokens with the same name and a different address are not Nomad's.

## How it works

1. **Integration suggestions.** Anyone can suggest a new agent platform or tool for Nomad to support.
2. **Builder bounties.** Nomad picks the integrations it wants next and posts a bounty for each, paid in $NOMAD from the treasury.
3. **Verification.** Builders submit the integration as a pull request. It is reviewed and must pass Nomad's adapter contract tests and security checks before it is merged.
4. **Payout.** Once the integration is merged and verified, the builder receives the bounty.
5. **Ecosystem expansion.** Each completed integration makes Nomad useful to more agent builders and users, which brings more suggestions and more work for the community.

## The flywheel

1. The community suggests integrations.
2. Nomad picks the next one.
3. The treasury funds a builder bounty for it.
4. Builders develop the integration and pass the tests.
5. Verified integrations expand what Nomad can move.
6. More integrations bring more users, more builders and more suggestions.

## Taking part

### Suggest an integration

Use the [suggestion form](https://github.com/kadiri-seer/nomad/issues/new?template=integration-proposal.yml) on GitHub: give the app's name and, if you like, why it should be next.

### Check the payouts

Every bounty payment comes from the treasury, directly or through Bull's escrow, and is linked on its [bounty issue](https://github.com/kadiri-seer/nomad/issues?q=is%3Aissue+in%3Atitle+%22%5BBounty%5D%22), so anyone can confirm who was paid and how much. The [holders list](https://robinhoodchain.blockscout.com/token/0x14c0a77e792f6c9818888630e95c50cf3b48c979?tab=holders) is public on the explorer too.

## The treasury

Bounties are paid from Nomad's treasury on Robinhood Chain. The amount of every bounty is stated when it is posted.

## Fees, buybacks and burns

$NOMAD also pays for [minting an agent](https://www.thenomad.website/agents) and for copies of minted agents (see [the economy](economy.md)). Part of each mint fee, and part of Nomad's share of each copy, is burned: sent to the dead address, `0x000000000000000000000000000000000000dEaD`, where no one can move it again. The rest goes to the treasury, and a copy's price minus Nomad's share goes to the agent's owner.

When finances permit, the treasury may buy $NOMAD and burn it. Each buyback and burn is sent from the treasury and shown with its transaction on the [economy page](https://www.thenomad.website/economy), together with the treasury, revenue and Nomad AI's running costs.

## What the token does not include

Buybacks, burns and fees can change or stop at any time, and none are promised, on any schedule or in any amount. The token comes with no staking and no share of revenue, and holding it is not a share in Nomad or its income.

## Building an integration for a bounty

An integration is an adapter: code that reads an agent from a platform and writes one back.

- Follow [Building an adapter](adapters/building-an-adapter.md) and declare honestly what the platform can and cannot hold.
- Run the adapter contract (`runAdapterContract` from `@nomad/sdk`) against a realistic fixture of the platform: detection, reading without side effects, writing through the engine, verification, and idempotent re-writes.
- Plant fake keys in your fixture and pass them as `secrets`. The contract fails if any of them appears in a plan, a receipt or a written file. Wallet folders and key files must never be read.
- Comment on the bounty issue with the wallet address for your payout, then open the pull request. CI runs the full suite on Linux, macOS and Windows; all of it has to pass.
