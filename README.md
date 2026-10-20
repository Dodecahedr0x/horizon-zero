# Horizon Zero

A Solana auto-battler. Build an army, give each unit a behavior, lock it into a battleground with a SOL stake, and watch the fight play out. The program pairs your army with another player's, MagicBlock VRF seeds the battle, and a deterministic combat engine decides the winner on chain. The winner takes the pot, less a protocol fee. The same engine replays every battle in the browser, line for line.

- **Program:** `zeroDcScmnx7TSvWvnKBa81Gcq34T1QSRWH182YdqRg` (Anchor)
- **Runs on:** a [MagicBlock](https://www.magicblock.gg/) ephemeral rollup, with Solana as the base layer
- **Spec:** [`docs/`](docs/src/SUMMARY.md), an mdBook that is the source of truth for every rule below

## How a match runs

1. **Register.** A wallet creates one Player account on Solana, deposits SOL, and moves some of it into a staking budget.
2. **Build.** Behaviors are short, immutable programs: up to 4 elements, each with a movement and up to 3 actions. An army is up to 10 catalog units placed in your starting zone, each bound to a behavior and kept within the battleground's budget.
3. **Lock.** `lock_army` queues the army, or matches it against one of the first 8 armies in the queue and locks one stake from each Player.
4. **Seed.** MagicBlock VRF answers with a random seed. The seed fixes the rubble on the board, initiative and tie-breaks.
5. **Settle.** Anyone may send `settle_match`. It plays the battle with `crates/combat` and pays the winner `2 × stake − fee` (5% at launch, capped at 10%). A draw returns both stakes.
6. **Cash out.** Winnings leave the rollup through a one-shot Outbox, which pays the wallet back on Solana.

A battle whose seed never arrives can be cancelled by anyone after 600 seconds, and both stakes go back. Every battle is capped in compute (`WORK_LIMIT`), so a settlement always fits in one transaction. A battle that hits the cap goes to the side with the larger share of its hp left.

### Battlegrounds and races

| battleground | budget | stake | grid |
| --- | --- | --- | --- |
| Outpost | 8 | 0.01 SOL | 8×6 |
| Garrison | 16 | 0.05 SOL | 10×8 |
| Citadel | 32 | 0.1 SOL | 12×10 |

There are three races, priced differently: **Ashborn** (cheap, many bodies), **Deeplings** (average) and **Rootborn** (few and large). Unit stats and casts live in [`content/catalog.json`](content/catalog.json) and in the engine's catalog. The full tables are in [Overview](docs/src/overview.md) and [Battle rules](docs/src/battle.md).

## Repository layout

| path | what |
| --- | --- |
| [`programs/horizon-zero`](programs/horizon-zero) | the Anchor program: accounts, matchmaking, VRF callback, settlement, Outbox cash-out, admin |
| [`programs/mock-vrf`](programs/mock-vrf) | a stand-in VRF program for the LiteSVM tests |
| [`crates/combat`](crates/combat) | the deterministic battle engine, shared by the program and the wasm replay |
| [`app`](app) | the game: Vite + React page, the game server (`app/server.js`) that builds transactions for the wallet, and a no-wallet local ledger for dev mode |
| [`indexer`](indexer) | Rust indexer (Carbon + SQLite) over the rollup, serving the read API behind `/api` |
| [`landing`](landing) | the public landing page, a static site |
| [`content`](content) | the catalog and the trace parser shared by every client |
| [`assets`](assets) | approved unit and board art |
| [`tools/asset-studio`](tools/asset-studio) | local tool for generating and approving art and for balance testing |
| [`tests/litesvm-suite`](tests/litesvm-suite) | program tests on LiteSVM |
| [`scripts`](scripts) | local stack, dev runner, deploy and build guard |
| [`docs`](docs) | the system spec (mdBook) |

## Prerequisites

- Node **22.18+** (24 in CI) and **pnpm 10**
- Rust, with **1.97.1** for the LiteSVM suite and program host tests (`cargo +1.97.1 …`)
- The Anza Solana CLI **v4.2.1** (`solana`, `solana-test-validator`, `cargo-build-sbf`)
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) to rebuild the browser and Node replay engines
- [`mdbook`](https://rust-lang.github.io/mdBook/) 0.5 to build the docs
- For the local chain: `npm install -g @magicblock-labs/ephemeral-validator@0.14.10` (provides `mb-stack` and `vrf-oracle`)

```bash
pnpm install
```

Copy [`.env.example`](.env.example) to `.env` for local settings. Every variable is optional for local work.

## Run it

**Dev mode, no wallet and no chain.** The game runs against a local ledger that applies the program's rules in Node and resolves battles with the same engine:

```bash
pnpm dev:all
```

**Against a real local chain.** This starts a Solana validator with the MagicBlock rollup, the VRF oracle and the indexer, builds and deploys the program, and creates the battlegrounds. It stays in the foreground, and Ctrl-C stops everything:

```bash
pnpm localnet
```

Then, in another terminal, play with a Phantom or Solflare wallet pointed at localnet:

```bash
pnpm dev:chain
```

`pnpm localnet:fund` airdrops 10 SOL on the local validator. Each `pnpm localnet` start is a fresh chain.

**Other tools:**

```bash
pnpm studio
```

```bash
pnpm indexer
```

## Test

The same steps CI runs ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

```bash
cargo test -p combat
```

```bash
cargo +1.97.1 test -p horizon-zero
```

```bash
cargo-build-sbf --manifest-path programs/mock-vrf/Cargo.toml
```

```bash
cargo-build-sbf --manifest-path programs/horizon-zero/Cargo.toml -- --features inline-mock-vrf,inline-mock-magic
```

```bash
cargo +1.97.1 test -p horizon-litesvm-tests -- --test-threads=1
```

```bash
pnpm --filter app test
```

```bash
pnpm --filter asset-studio test
```

The indexer's tests run from inside `indexer/`, which pins its own toolchain:

```bash
cd indexer && cargo test
```

After changing the engine, rebuild the replay engines and run the app tests. The golden trace in `crates/combat/golden/` must still replay:

```bash
wasm-pack build --target nodejs --out-dir ../../app/src/combat-node crates/combat --features wasm
```

```bash
wasm-pack build --target web --out-dir ../../app/src/combat-wasm crates/combat --features wasm
```

The end-to-end check plays, settles and cashes out one battle on a fresh local stack, then exits:

```bash
pnpm localnet:check
```

> **Mock builds never ship.** The LiteSVM build (`inline-mock-vrf`, `inline-mock-magic`) writes the same `target/deploy/horizon_zero.so` as a real build. `scripts/program-build.mjs` records each real build's features, validator, VRF queue and hash. The local stack and deploy script refuse anything else, so rebuild with `pnpm localnet` or the deploy script after running the suite.

## Deploy

The program bakes in two keys at build time instead of reading them from Config:

- `HZ_VALIDATOR`, the rollup validator every account is delegated to
- `HZ_VRF_QUEUE`, the only VRF oracle queue `lock_army` will ask

A real SBF build refuses to compile without them. The deploy script sets both, checks the validator against the rollup's `getIdentity`, deploys or upgrades the program, and bootstraps Config and the battlegrounds:

```bash
pnpm deploy:devnet --er-url <rollup rpc> --validator <rollup identity>
```

```bash
pnpm deploy:mainnet --confirm-mainnet --er-url <rollup rpc> --validator <rollup identity>
```

The program keypair `target/deploy/horizon_zero-keypair.json` must hold the program ID above. It is git-ignored, so back it up: without it the program cannot be upgraded. The deploying wallet is the upgrade authority and becomes the admin. It can hand the role on with `set_admin` and `accept_admin`.

[`render.yaml`](render.yaml) describes the hosted setup: the game web service, the indexer, and the static landing site. The game server needs `RPC_URL`, `ER_RPC_URL` and `ORACLE_QUEUE`, and the indexer needs `SOLANA_RPC_URL` (the rollup). See [Networks and deployment](docs/src/deployment.md) and [Indexer and Render](docs/src/indexer.md).

## Security model

- **Trusted:** the program, the MagicBlock rollup validator built into it, and the VRF oracle queue built into it.
- **Server-built transactions are checked in the browser.** The game server builds every transaction, and the page checks each one before the wallet signs it (`app/src/txCheck.ts`). The fee payer and the only signer must be the wallet. Every instruction must come from this program, a compute-unit limit, or (for a top-up) the eSPL transfer. Amounts must match what the player entered.
- **Settlement is permissionless**, and every account it touches is checked against the battle. A caller cannot redirect a payout.
- **Known limits** are listed in [Matchmaking](docs/src/matchmaking.md):
  - a locker can bias which of the 8 front-of-queue armies it meets;
  - accounts depend on the rollup staying up;
  - a Player cannot be undelegated by itself.

## Documentation

The book in [`docs/`](docs/src/SUMMARY.md) is the spec: battle rules, every account and instruction, matchmaking and money flows, the client, the indexer, deployment, and testing. Build it with:

```bash
mdbook build docs
```

Diagrams are mermaid source blocks. When you change behavior, update the matching chapter and its diagrams in the same change ([`AGENTS.md`](AGENTS.md)).

## Status

Pre-release. The repository has no license file yet.
