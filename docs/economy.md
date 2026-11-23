# Nomad's economy

How money moves around Nomad, and where each part can be checked. The live numbers are on the
[economy page](https://www.thenomad.website/economy); nothing there is estimated or projected.

## The parts

1. **Revenue.** Nomad's share of QHooks fees on trades routed through Nomad goes to the referral wallet
   (`0xD4bA760227cdDCD879c9d05Fbd908eb69b50dD7c`). The unburned part of agent mint fees and of Nomad's share of copy
   sales goes to the treasury.
2. **Nomad AI's operating budget.** Nomad AI counts what each run costs (AI, OddsEngine safety checks, network fees and
   any payments) and stops for the month when it reaches its monthly budget. It publishes the totals after every run
   to its feed (`kadiri-seer/nomad-ai-feed`, `economy.json`).
3. **Payments for services.** Nomad AI can pay a service only through Upoch, only to a recipient listed in its guard's
   policy, only that recipient's exact amount and only when due. This is off until a recipient is listed. See the
   Nomad AI repo's README.
4. **Builder bounties.** Integrations that win a holder vote get a bounty in $NOMAD from the treasury, a Safe that needs
   two approvals. Bounties are GitHub issues labelled `bounty`; each payout is linked on its issue.
5. **Minted agents.** Creators mint agents with the NomadAgents contract (`contracts/`) for a fee in $NOMAD and set a
   price for copies. Part of each fee is burned. See [contracts/README.md](../contracts/README.md).
6. **Paid copies.** A creator can deliver an agent encrypted: the browser encrypts the `.nomad` file before upload,
   the encrypted file goes to IPFS (through Filebase), and its key is kept in the site's database. The key is given
   only to a wallet that signs in and, checked on the contract at that moment, owns the agent, created it or has a
   copy (anyone, for a free agent). The buyer's browser decrypts the file and checks it against the SHA-256 recorded
   on-chain. Anyone who has downloaded a package can still share it; this makes paying the way to get it, not a lock.
   The site needs `FILEBASE_IPFS_TOKEN` (a Filebase IPFS RPC API key) set in Vercel for uploads.
7. **Buybacks and burns.** When finances permit, the treasury may buy $NOMAD and burn it. None are promised.

## Treasury actions

Nothing is sent from a script. `scripts/economy/safe-batch.mjs` writes a batch file for the Safe's Transaction
Builder; you load it in the Safe, check it and sign it with two approvals.

| Action | Command |
| --- | --- |
| Burn $NOMAD | `node scripts/economy/safe-batch.mjs burn 250000` |
| Pay a bounty | `node scripts/economy/safe-batch.mjs bounty 12 0xBuilderAddress 250000` |
| Open or close minting | `node scripts/economy/safe-batch.mjs open-minting 0xNomadAgents` |
| Change the mint fee | `node scripts/economy/safe-batch.mjs mint-fee 0xNomadAgents 10000 50` |
| Change the copy share | `node scripts/economy/safe-batch.mjs platform 0xNomadAgents 10 50` |
| Record a buyback | `node scripts/economy/safe-batch.mjs record-buyback --date 2026-12-01 --spent "500 USDG" --bought "1200000 $NOMAD" --tx 0x... --burn-tx 0x...` |

A buyback is two steps from the Safe: buy $NOMAD (with the Safe's swap feature, or a swap app connected to the Safe),
then burn what was bought with a burn batch. Then record it with `record-buyback`, commit `governance/economy.json`
and push: the economy page lists only buybacks that link their own transaction.

## Where to check

| What | Where |
| --- | --- |
| Treasury, referral and Nomad AI balances | The explorer, linked from the economy page |
| $NOMAD burned | The dead address `0x000000000000000000000000000000000000dEaD` on the explorer |
| Nomad AI's costs | `economy.json` in `kadiri-seer/nomad-ai-feed` |
| Bounties | GitHub issues labelled `bounty` |
| Buybacks | `governance/economy.json`, each with its transaction |
| Minted agents and their fees | The NomadAgents contract's events on the explorer |

Buybacks, burns and fees can change or stop at any time, and none are promised. Holding $NOMAD is not a share in
Nomad or its income, and nothing here is financial advice.
