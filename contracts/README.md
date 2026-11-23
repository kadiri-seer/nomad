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
| Mint fee | 142,000 $NOMAD (about $5 on Nov 23, 2026) | Yes, up to the maximum |
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

1. Open `https://www.thenomad.website/agents/deploy` in a browser with your wallet, on Robinhood Chain. Check the
   settings, then deploy. Your wallet signs the deployment and pays its gas; it does not become the owner (the
   Safe does).
2. Verify it on the explorer: on the contract's Blockscout page, choose "Solidity (Standard JSON input)", compiler
   v0.8.28, and upload `artifacts/NomadAgents.standard-input.json`. The page shows the constructor arguments to
   paste.
3. Set `NEXT_PUBLIC_AGENTS_CONTRACT` to the contract's address in the site's Vercel settings and redeploy the site.
4. For encrypted paid copies, set `FILEBASE_IPFS_TOKEN` in Vercel to a Filebase IPFS RPC API key (the same kind
   of key Upoch uses) and redeploy. Without it, creators can still mint with a public link.
5. When you are ready, open minting from the Safe: `node scripts/economy/safe-batch.mjs open-minting` writes a
   batch for the Safe's Transaction Builder (two approvals).
