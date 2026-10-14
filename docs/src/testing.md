# Testing

Two CI jobs live in `.github/workflows/ci.yml`. Both install Anza `v4.2.1`.

## Combat, wasm, and LiteSVM

Job `litesvm` uses Rust `1.97.1`.

1. `cargo test -p combat`, including the golden trace.
2. `cargo-build-sbf` for `programs/mock-vrf` and `programs/mock-hydra`.
3. `cargo-build-sbf` for `programs/horizon-zero` with `--features inline-mock-vrf`.
4. `cargo test -p horizon-litesvm-tests -- --test-threads=1`.
5. `wasm-pack` builds of `crates/combat` (`--features wasm`) into `app/src/combat-node` and `app/src/combat-wasm`.
6. `pnpm --filter app test` and `pnpm --filter asset-studio test`. The app command runs the combat golden replay and `app/local-ledger.test.mjs`.

LiteSVM loads `horizon_zero.so` at `Hm19JfKaKCRphRwF7DbxhJWmLpHgMG1SnEnKGRyN9Z7c`, `mock_vrf.so` at `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`, and `mock_hydra.so` at `Hydra17i1feui9deaxu6d1TzSQMRNHeBRkDR1Awy7zea`. The suite creates its own oracle-queue account, owned by the VRF program id, with 256 zero bytes. That is enough for the ownership check. It is not a MagicBlock queue.

The fixture calls `initialize`, then `create_battleground` for the three catalog maps: Outpost `(0, budget 8, stake 50_000_000, 8×6)`, Garrison `(1, budget 16, stake 200_000_000, 10×8)`, and Citadel `(2, budget 32, stake 1_000_000_000, 12×10)`. Each account is 576 bytes and stores `zone_depth` 2.

`programs/mock-vrf` accepts a request and fulfills it on a second instruction, because a callback into `horizon-zero` while `lock_army` is still on the stack is rejected.

| first byte | mock behavior |
| --- | --- |
| 10 or 11 | request accepted, no callback |
| 12 | parse the request and invoke the callback immediately |
| anything else | return success and do nothing |

Instruction 12's callback data is the 8-byte `seed_match` discriminator, then the caller seed, then the request args. The caller seed is therefore the `randomness` argument. Tests assert the stored battle seed equals `SHA-256(battle pubkey)`.

`inline-mock-vrf` makes `request_vrf` invoke the VRF program with a plain `invoke_signed` on the request's own accounts; the mock accepts it without a callback. The tests append a separate instruction 12 after `lock_army` in the same transaction, which runs `seed_match`. That feature is absent from the localnet build.

`programs/mock-hydra` stands in for Hydra, which neither LiteSVM nor `mb-stack` ships. It implements `Create`, `Trigger`, `Cancel` and `Close` on `hydra-api` 0.2.0's account layout with the same checks: payer-bound crank addresses, no signer flags in a template, `Trigger` only at the top level, due, not exhausted, a byte-for-byte match of the next instruction against the stored template, and the 10 000-lamport cranker reward. Like the real `Create`, it also accepts a crank address that already holds lamports, topping it up and then allocating and assigning it; the match test sends lamports to the next battle's crank address first to cover that. With `HZ_HYDRA_SO=<hydra.so>`, the suite loads a real Hydra build from [magicblock-labs/hydra](https://github.com/magicblock-labs/hydra) (`cargo build-sbf --manifest-path programs/hydra/Cargo.toml` there) instead of the mock, and passes unchanged. The tests crank a battle as a cranker would: they read the crank account, rebuild the scheduled instruction from it, and send a compute limit, `Trigger`, and that instruction from a fresh cranker.

The match test follows one battle through every step: after the callback the battle is Seeded with the seed stored, the vault is empty, and the crank is owned by Hydra, has the battle as authority and one run; replaying the callback fails with `AlreadyResolved`; `settle_match` alone fails with `NotCranked`; a template with an extra account fails Hydra's follow-up check; a crank another payer created with the same template triggers but `settle_match` refuses it with `NotCranked`; while the battle is unsettled each pot has staked once and counts one fight, so `close_pot` fails with `PotBusy`; the real crank settles the battle, pays the cranker 10 000 lamports, is closed, and returns its rent to player B's wallet, and the payout lands in the pots' budgets; a second run fails. It also asserts that `seed_match` stays under 100 000 CU.

`a_rootborn_army_stores_its_own_catalog_rows` creates a race `1` army in Outpost: Rootborn kind `3` fails with `BadUnit`, race `3` with `BadRace`, three Thornlings (cost 12) go over the budget, and two Thornlings are stored with race byte `1` and the Thornling's catalog cost and hp. A Clawling and a Spineshot then make a race `2` army, stored with race byte `2` and the Clawling's cast damage; the unknown race is `3`.

`close_army_needs_the_owner_and_an_idle_army` checks that a stranger gets `NotOwner`, that a queued army gets `BadStatus`, that after `unlock_army` the owner closes the army, logs `HZ_ARMY_CLOSE`, and gets its rent back, and that the same index then creates a new army at the same address. `app/local-ledger.test.mjs` checks the ledger's delete route the same way (refused while Fighting, then gone, then 404) and the per-player match list.

`full_armies_resolve_on_every_battleground` plays full-budget armies on all three battlegrounds, 10 units a side on Citadel, through the mock VRF and the crank and prints what `settle_match` consumed; [Callback compute](matchmaking.md#callback-compute) lists the numbers. The suite also checks duplicate behaviors, hash mismatch, budget, unknown behavior, wrong owner, a position outside the zone, a repeated tile, winner payment, draw refund, and that a player does not match their own queued army or a queued army in another battleground.

Three tests cover pots. `locking_needs_a_pot_that_covers_the_stake_and_unlock_dequeues`: locking without a pot fails with `AccountNotInitialized` and with a pot one lamport short with `PotTooLow`; a covered lock queues without moving lamports, and unlock leaves the queue. `one_pot_backs_many_armies_until_it_runs_dry`: one owner queues three armies on a pot of two stakes; two lockers each meet a different one of them while the budget drops a stake at a time; the third locker then queues instead of meeting the last army, and the owner's next lock fails with `PotTooLow`. `segregated_payouts_stay_out_of_the_budget_and_withdraw_first`: a stranger cannot set segregation; with it on, a draw refunds the stake into `winnings`; a withdrawal takes the winnings first, then the budget; asking for more than both fails with `PotShort`; and `close_pot` returns the rest with the rent. Combat tests cover the blocked-tile rules, including a one-column choke that stays open and a scripted tile a unit does not step on. The host comparison that finds which battleground an army stored is a byte slice of account data. The program itself does not compare `AccountInfo` keys with `[u8; 32] ==`.

## Local stack

Job `localnet` installs `@magicblock-labs/ephemeral-validator@0.14.10` globally and runs `pnpm localnet:check`, which is `scripts/local-stack.mjs --check`. The same script without `--check` is `pnpm localnet`, the local cluster for development (see [Networks and deployment](deployment.md)).

The script builds `programs/horizon-zero` with default features, so `inline-mock-vrf` is off, builds `programs/mock-hydra`, and starts `mb-stack` from that package: a `solana-test-validator` base layer on `8899` with the MagicBlock delegation and VRF programs and the VRF queues preloaded, the ephemeral validator on `7799`, and the query-filtering front on `6699`. `horizon_zero.so` is loaded into the base validator at the Horizon program id and `mock_hydra.so` at the Hydra id. The base validator's gossip, dynamic and faucet ports are moved to `18000`, `18100-18200` and `19900` so the stack can run next to another local validator. The ledger, the logs and a generated admin keypair live in `target/localnet/`. `vrf-oracle` from the same package then runs against the base layer with its built-in local identity and serves the SDK test queue `GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb`. That queue's dumped account carries stale requests from older slots; the oracle keeps retrying them and they fail with "fulfill in a different slot", which does not block new requests.

The script airdrops to the admin keypair and runs `app/scripts/bootstrap.mjs`: `initialize`, the three catalog battlegrounds, and every standard behavior from `content/catalog.json`, each skipped when its account exists. It then funds `target/localnet/cranker.json` and starts `app/scripts/hydra-cranker.mjs`, which polls the Hydra program's accounts every second and sends `SetComputeUnitLimit`, `Trigger` and the stored instructions for each due crank, retrying a failed crank after 10 seconds. Its log is `target/localnet/hydra-cranker.log`.

To run the check against the real Hydra program and MagicBlock's cranker, build both from [magicblock-labs/hydra](https://github.com/magicblock-labs/hydra) (`cargo build-sbf --manifest-path programs/hydra/Cargo.toml`, and `CARGO_PROFILE_RELEASE_LTO=false cargo build -p hydra-cranker --release`) and point the script at them:

```sh
RUST_LOG=info HZ_HYDRA_SO=<hydra>/target/deploy/hydra.so HZ_HYDRA_CRANKER=<hydra>/target/release/hydra-cranker pnpm localnet:check
```

The script then loads that `hydra.so` at the Hydra id and starts `hydra-cranker --rpc-url http://127.0.0.1:8899 --ws-url ws://127.0.0.1:8900 --keypair target/localnet/cranker.json` in place of the JS cranker. The cranker needs the explicit WebSocket URL: it otherwise derives one on the RPC port.

With `--check`, `app/scripts/localnet-assert.mjs` then uses two wallets in Outpost only: budget 8, stake `50_000_000`, 8×6, one Guard each at zone-local `(0, 0)`, behavior March. Each wallet funds its Outpost pot with one stake. The first `lock_army` queues. The second passes that army and its owner's pot as the opponent. The second lock also passes the battle's crank vault. The script polls the battle account for up to 60 seconds until the status byte (offset 2108) is 1, which takes both the oracle's callback and the cranker's settlement, then requires the crank and the vault to be empty. Pass `--content <file>`, or set `HZ_CONTENT`, and the script also creates every base behavior in that file; existing accounts are skipped. The script requires a non-zero seed, an outcome equal to `simulate_json` on the stored `cols`, `rows`, snapshots (including the canonical body, positions, cast with its cooldown, and `actions`), and that seed, the winner's pot budget to hold both stakes and the loser's none (one stake each on a draw), and the battle balance to sit under one stake. That seed is the oracle's randomness. The LiteSVM mock is the path that stores `SHA-256` of the battle pubkey. The script exits, and the stack stops, when the battle resolves.

## Compute benchmark

`cu_benchmark` in `tests/litesvm-suite/tests/game.rs` is ignored by default. It plays a fixed, seeded set of battles through `settle_match`: 8 per battleground, each between two random budget-legal armies, each army on one random standard behavior, with a random VRF seed. The settlement runs in the crank's own transaction with the whole 1 400 000 CU, and the VM runs on mainnet's runtime features. It prints the mean and maximum per battleground and the total, and writes every battle's compute, rounds and outcome to `target/cu-bench.json`; it also asserts each on-chain outcome equals the host simulation. Comparing outcomes and rounds between two runs shows that an optimization changed no battle.

```sh
cargo-build-sbf --manifest-path programs/horizon-zero/Cargo.toml -- --features inline-mock-vrf
cargo test -p horizon-litesvm-tests cu_benchmark -- --ignored --nocapture
```

Built with `--features "inline-mock-vrf cu-profile"` (the program feature turns on `combat/cu-profile`), the engine also reads the remaining compute around each phase and logs per-phase totals at the end of a battle (`crates/combat/src/profile.rs`); the benchmark's VM enables the `sol_remaining_compute_units` syscall and a 10 000 000 CU limit for that build, and prints each phase's net cost (minus about 100 CU per probe), share and calls: rubble, setup, movement (with its target choice, path lookups and wave steps), actions (with their target choice), expiry, and the program's work before the simulation. Without the feature the probes compile to nothing.

| step | total for the 24 battles | change |
| --- | --- | --- |
| before | 14 233 385 CU | |
| tighter path-search loops | 12 970 118 | -8.9% |
| one walking-distance field per goal | 10 588 549 | -25.6% |
| skip the lookup next to the goal | 10 003 032 | -29.7% |
| resumable per-goal waves | 8 920 606 | -37.3% |
| occupancy bit masks | 8 198 466 | -42.4% |
| double-buffered waves | 7 652 482 | -46.2% |
| last-used wave first | 7 624 203 | -46.4% |
| no whole-fighter copies | 7 604 204 | -46.6% |
| one PDA derivation in the settlement | 7 580 585 | -46.7% |
| unchecked indexing in the walking-distance wave | 7 407 533 | -48.0% |
| settlement moved to the Hydra crank | 7 616 315 | -46.5% |

The last row is not an optimization: `settle_match` derives the vault and crank addresses, reads the instructions sysvar, and cancels the crank, about 9 000 CU per battle on top of the simulation. Every battle's outcome is unchanged.

Tried and dropped, because they cost as much or more: 12 wave slots instead of 8 (-0.1%), three bit-mask versions of the rubble connectivity check (the depth-first fill reaches zone B after touching few tiles and was cheapest), sorting rubble candidates by a hash prefix, caching target tie keys per round, and unchecked indexing on every fighter access (-0.7%, not worth spreading `unsafe` through the engine).
