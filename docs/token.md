# Token and builder bounties

Nomad's token has two jobs: governance and funding development. Token holders decide which integrations Nomad gets next, and the treasury pays the builders who deliver them. The token coordinates the people deciding what Nomad becomes and the builders making it happen.

## How it works

1. **Integration proposals.** Anyone can propose a new agent platform or tool for Nomad to support. Proposals that the maintainers accept as buildable go forward to a vote.
2. **Community voting.** Token holders vote on which accepted integration is built next.
3. **Builder bounties.** The treasury funds a bounty, paid in tokens, for the winning integration.
4. **Verification.** Builders submit the integration as a pull request. It is reviewed and must pass Nomad's adapter contract tests and security checks before it is merged.
5. **Treasury payout.** Once the integration is merged and verified, the builder receives the bounty.
6. **Ecosystem expansion.** Each completed integration makes Nomad useful to more agent builders and users, which brings more proposals and more work for the community.

## The flywheel

1. The community proposes integrations and token holders vote.
2. The vote selects the next integration.
3. The treasury funds a builder bounty for it.
4. Builders develop the integration and pass the tests.
5. Verified integrations expand what Nomad can move.
6. More integrations bring more users, more builders and more proposals.

## What the token does not include

The token comes with no buybacks, no staking and no share of revenue, and none are promised. Holding it gives a vote on Nomad's roadmap and nothing else.

## Building an integration for a bounty

An integration is an adapter: code that reads an agent from a platform and writes one back.

- Follow [Building an adapter](adapters/building-an-adapter.md) and declare honestly what the platform can and cannot hold.
- Run the adapter contract (`runAdapterContract` from `@nomad/sdk`) against a realistic fixture of the platform: detection, reading without side effects, writing through the engine, verification, and idempotent re-writes.
- Plant fake keys in your fixture and pass them as `secrets`. The contract fails if any of them appears in a plan, a receipt or a written file. Wallet folders and key files must never be read.
- Open the pull request. CI runs the full suite on Linux, macOS and Windows; all of it has to pass.
