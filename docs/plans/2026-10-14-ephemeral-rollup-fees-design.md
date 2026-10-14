# Ephemeral rollup gameplay and protocol fee

Status: approved design, not implemented. Once the work lands, the chapters under `docs/src/` are the spec and this file is history.

## Goals

- Take a protocol fee on the winner's payout. The admin can claim it.
- Run gameplay on a MagicBlock ephemeral rollup. Each player has one delegated account. Everything else the player creates is an ephemeral account that the player account sponsors.
- Players top up and withdraw without undelegating the player account.
- Stake tiers are 0.01, 0.05, and 0.1 SOL.

## Accounts

Delegated. Each is created on Solana and then delegated to the rollup:

| account | seeds | contents |
| --- | --- | --- |
| Config | `[b"config"]` | `admin`, `fee_bps` (default 500, max 1000), `fees` (claimable lamports held on Config apart from its rent) |
| Battleground | `[b"battleground", id]` | admin-created. Delegated because `lock_army` writes its queue. |
| Player | `[b"player", owner]` | one per wallet. Its lamports are the balance. Holds `budget`, `winnings`, `segregate`, `locked`, and `fighting`. Sponsors the owner's ephemeral accounts. |
| Outbox | `[b"outbox", owner]`, `[b"outbox", config]` | one-shot cash-out account for each player and for the treasury |

Ephemeral accounts. They exist only in the rollup. The sponsor signs with PDA seeds, and the rent is `(bytes + 60) * 32` lamports:

| account | sponsor | rent | lifetime |
| --- | --- | --- | --- |
| Army | owner's Player | ~45k lamports | `close_army` refunds it |
| Behavior | creator's Player | ~5.7k lamports | never closed |
| Battle | matching player's Player | ~30k lamports | `settle_match` closes it and refunds the sponsor |

Removed: Pot (merged into Player), the crank vault, the Hydra crank, `mock-hydra`, and the cranker reward.

Stakes: Outpost 0.01 SOL, Garrison 0.05, Citadel 0.1. They are set in `content/catalog.json` and created by `bootstrap.mjs`. The program still accepts any stake.

## Player balance

`free = lamports - rent_exempt_min - budget - winnings - locked`.

- Free lamports pay ephemeral rent. Top-ups land in them.
- `fund_budget(amount)` moves free lamports into `budget`.
- `set_segregation` routes payouts to `winnings` instead of `budget`. `winnings` is never staked.
- Invariant: `lamports >= rent_exempt_min + budget + winnings + locked`. Creating an ephemeral account fails if its rent would break the invariant.

## Match flow (rollup)

1. `lock_army` requires `budget >= stake`. It picks an opponent from the queue using the slot hash, as today. On a match it creates the ephemeral Battle, sponsored by the locker. For both players it moves `budget -= stake`, `locked += stake`, and `fighting += 1`. It snapshots `fee_bps` into the Battle and requests VRF on `DEFAULT_EPHEMERAL_QUEUE`. With no opponent, the army is queued.
2. `seed_match` is the VRF callback. It stores the seed and sets the battle to Seeded.
3. `settle_match` is permissionless and runs on a Seeded battle. `pot = 2 * stake` and `fee = pot * fee_bps / 10_000`, rounded down.
   - Win: `locked -= stake` for both players. The loser's Player sends `stake` lamports: `fee` goes to Config (`fees += fee`) and `stake - fee` goes to the winner's Player. The winner's `budget` or `winnings` grows by `pot - fee`.
   - Draw: both players get `locked -= stake` and `budget += stake`. No lamports move and no fee is taken.
   - Both armies go back to Idle and both `fighting` counts drop by one. The Battle is closed. The instruction logs `HZ_MATCH_RESOLVED <battle> <outcome> <fee> ...`.

Stakes never leave the Player accounts until settlement, because ephemeral accounts cannot escrow lamports.

Example: at Garrison with a 5% fee, the pot is 0.1 SOL and the fee is 0.005. The winner nets +0.045 and the loser loses 0.05.

Admin: `initialize(fee_bps)` and `set_fee(fee_bps)` fail with `FeeTooHigh` above 1000.

## Money in and out

- Onboarding, on Solana: `register_player(deposit)` creates Player and Outbox, funds the Player, and delegates both.
- Top-up, on Solana: the SDK's `LamportsDelegatedTransfer` (TS `lamportsDelegatedTransferIx`) targets the Player PDA. MagicBlock charges 300k lamports for the helper. The deposit lands in free lamports.
- Withdraw, in the rollup: `withdraw(amount)` takes free lamports first, then `winnings`, then `budget`, and never touches `locked`. It moves the lamports to the Outbox and records the amount there. It then schedules commit-and-undelegate of the Outbox with a Magic Action. On Solana, the action runs `release_outbox`, which pays the owner. `release_outbox` is permissionless, because the delegation program invokes actions through a signing escrow and the program cannot tell that call from any other. It only pays the recorded owner, and the client calls it itself if the action has not run. Before the next withdrawal, the client delegates the Outbox again on Solana with `delegate_outbox`, paid by the wallet. Each withdrawal opens a new delegation session for the Outbox, at about 0.0003 SOL (spike-measured). Only one withdrawal can be in flight per player, because an undelegated Outbox is not writable in the rollup.
- Fee claim, in the rollup: `claim_fees` is admin-only. It moves `fees` to `[b"outbox", config]` and sets `fees` to 0. It uses the same commit-and-undelegate and action, which pays `config.admin`.

Why an outbox: a delegated account's balance is mirrored to Solana at commit. A drop goes to the validator fees vault and a rise comes from it. On Solana the account stays owned by the delegation program. Lamports can therefore reach a wallet only from an account that undelegates. The outbox keeps the Player delegated while it does.

## Risks for the spike, checked first on the local stack

1. Check that an action attached to commit-and-undelegate runs after undelegation finalizes, so that `release_outbox` owns the Outbox and can debit it. Fallback: `withdraw` undelegates the whole Player account.
2. Check that the action can delegate the Outbox again, paying from the action escrow. Fallback: the client delegates it again on Solana before the next withdrawal.
3. Check that `CreateEphemeralAccount` accepts a PDA sponsor that signs through `invoke_signed`.

## Client

- Two connections: Solana for `register_player`, top-ups, and Outbox re-delegation, and the rollup for everything else.
- The first run shows a Create player step.
- The wallet panel shows free, budget, winnings, and locked, with Top up, Fund budget, and Withdraw. It shows in-flight state while the Outbox is undelegated.
- The client calls `settle_match` after `seed_match`. A duplicate call fails with `AlreadyResolved`.
- An admin view offers Claim fees and Set fee to `config.admin`.
- Dev mode (`devChain.ts` and the local ledger) mirrors one balance, the fee, and no Pots.

## Indexer

- `SOLANA_RPC_URL` points at the rollup RPC.
- Battles close at settlement, so the indexer adds `logsSubscribe` on the program. It writes the outcome and fee from `HZ_MATCH_RESOLVED` onto the battle row stored from the Seeded account.
- It decodes Player instead of Pot, plus the new Battle layout. Army pruning stays.

## Local stack and tests

- `mb-stack` runs gameplay. `mock-hydra` and the Hydra cranker are removed. `bootstrap.mjs` initializes, creates the 0.01, 0.05, and 0.1 battlegrounds, and delegates Config and the battlegrounds. `--check` plays one battle and one withdrawal.
- The combat tests do not change.
- The LiteSVM suite covers fee math, the invariant, settlement transfers, and the `set_fee` bounds, with the ephemeral-account CPI behind a feature.
- Delegation, sponsorship, and the outbox are covered by `pnpm localnet --check`.

## Docs

Update overview, accounts, matchmaking (renamed "Matchmaking, stakes, and VRF"), client, indexer, deployment, and testing. Update every mermaid diagram that shows Pots, Hydra, or the crank vault.

## Order

1. Spike
2. Program
3. LiteSVM tests
4. Client
5. Indexer
6. Scripts
7. Docs
