# Holder vote rounds

$NOMAD holders vote on which integration Nomad gets next. The rules are on the [token page](../docs/token.md); votes are cast on the [Vote page](https://nomad-iota-six.vercel.app/vote).

## How a round runs

1. Anyone suggests an app in the suggestion box on the Vote page, or with the GitHub suggestion form. Each hour the workflow posts new website suggestions as GitHub issues (repeats of an open suggestion are skipped) and publishes the open suggestions in `suggestions.json`, which the Vote page lists. Closing a suggestion's issue removes it from the list. People back listed suggestions on the site, once each.
1. A maintainer adds the `approved` label to suggestions that can be built safely.
2. The [Vote rounds](../.github/workflows/vote-rounds.yml) workflow runs every hour. Rounds run back to back: as soon as one closes, it opens the next. The approved suggestions with the most backing, counting site backs and GitHub thumbs-up reactions (up to five) go on the ballot, $NOMAD balances are recorded, and a round issue is opened. The first round is started by hand: Actions, Vote rounds, Run workflow, `open`.
3. Holders vote on the Vote page. Their wallet signs a message naming the round, the option and the wallet. Nothing is sent on chain. One vote per wallet.
4. 48 hours later the workflow closes the round. It downloads every signed vote, checks each signature again, recounts from the recorded balances, publishes the votes and the result here, and posts the outcome on the round issue and on each suggestion. The winner gets the `won` label.
5. A maintainer posts the bounty for the winner with the bounty form and funds it from the reward wallet.

## Files

| File | What it holds |
| --- | --- |
| `config.json` | Token, reward wallet, wallets that do not vote, timings and labels. |
| `suggestions.json` | Open suggestions shown on the Vote page, with their labels and thumbs-up counts. |
| `rounds/index.json` | The latest round number. |
| `rounds/round-N.json` | The ballot, the times, a summary of the balance snapshot and, once closed, the result. |
| `rounds/round-N-holders.json` | Every $NOMAD balance when round N opened, in the token's smallest unit. Voting power comes only from here. |
| `rounds/round-N-votes.json` | Every counted vote with its signature, written when the round closes. |

## Recounting a round yourself

For each vote in `round-N-votes.json`, rebuild the signed message:

```
Nomad vote
Round: N
Choice: #<issue> <label>
Wallet: <lowercase wallet address>
Weight: $NOMAD held when the round opened
```

Check that the signature recovers to the wallet (EIP-191 `personal_sign`), then add the wallet's balance from `round-N-holders.json` to its choice. Wallets listed in `excluded` count for nothing. The code that does this is `apps/web/lib/vote/`.

## Wallets that do not vote

The reward wallet and the team's wallets are listed in `excluded` in `config.json`. Changes apply from the next round.
