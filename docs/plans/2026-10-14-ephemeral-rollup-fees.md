# Ephemeral Rollup Gameplay and Protocol Fee Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move Horizon Zero gameplay onto a MagicBlock ephemeral rollup. Each wallet gets one delegated Player account that sponsors its ephemeral armies, behaviors and battles. The winner's payout pays a protocol fee that the admin can claim. Players top up and withdraw without undelegating their Player account.

**Architecture:** Config, Battleground, Player and Outbox are program PDAs created on Solana and delegated to the rollup. Army, Behavior and Battle become ephemeral accounts created through `MagicBlockInstruction::CreateEphemeralAccount`, with the Player PDA signing as sponsor. Stakes never leave the Player accounts until `settle_match`, which moves lamports loser → winner and loser → Config. Lamports leave the rollup through a one-shot Outbox: the rollup moves lamports into it and schedules commit-and-undelegate of the Outbox alone, with a post-undelegate action calling a permissionless `release_outbox` on Solana. Hydra, the crank vault and Pots are removed.

**Tech Stack:** Anchor 1.0.1, `ephemeral-rollups-sdk` 0.17.3 (`anchor` feature), `ephemeral-vrf-sdk` 0.17.3, LiteSVM 0.17, `@solana/web3.js` 1.98, `@magicblock-labs/ephemeral-rollups-sdk` (TS), Carbon 2.0 indexer, mdBook.

**Design:** [2026-10-14-ephemeral-rollup-fees-design.md](2026-10-14-ephemeral-rollup-fees-design.md). The design has two refinements, found while reading the SDK for this plan:

1. `release_outbox` is **permissionless**. The delegation program runs a base action through `CallHandler`, signed by an escrow PDA, so the program can't tell the action from any other caller. That's safe, because `release_outbox` only pays the owner recorded in the Outbox. The client calls it itself if the action hasn't run.
2. **Delegating the Outbox again is the client's job.** Before a withdrawal, if the Outbox is not owned by the delegation program on Solana, the client sends `delegate_outbox` (paid by the wallet) and then `withdraw` in the rollup. Every withdrawal opens a new delegation session for the Outbox, The spike measured the net cost of each session at about 300,000 lamports plus transaction fees. The UI must show that cost.

**Spike findings, binding on Tasks 10, 11, 14, 16 and 18.** Evidence is in [2026-10-14-outbox-spike-result.md](2026-10-14-outbox-spike-result.md), and working code is on branch `spike/outbox` (`spike/outbox/programs/spike/src/lib.rs`, `spike/outbox/run.mjs`, `spike/outbox/stack.sh`). Copy account lists from there.

- **Split the lamport move from the scheduling.** Moving lamports and scheduling commit-and-undelegate in one instruction fails with `UnbalancedInstruction`. Use two instructions in the same transaction:
  - `fund_outbox(amount)` moves the lamports and sets `amount`.
  - `withdraw` schedules commit-and-undelegate.
  - Do the same for fees: `fund_treasury_outbox` followed by `claim_fees`.
- **In the scheduling instruction, the Outbox is an `UncheckedAccount`.** Write any data to it by hand before scheduling. A typed `Account<Outbox>` there fails with `ExternalAccountDataModified`.
- **How the intent is built:**
  - Call `MagicIntentBundleBuilder::new(payer, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID).commit_and_undelegate(&[outbox]).add_post_undelegate_actions([CallHandler { destination_program: ID, accounts: [outbox (w), owner (w)], args: ActionArgs::new(ReleaseOutbox::DISCRIMINATOR), escrow_authority: payer, compute_units: 20_000 }]).build_and_invoke()`.
  - The payer is the signing wallet.
  - No escrow account needs to exist.
  - Import `FoldableIntentBuilder` explicitly.
  - The delegation program appends three accounts to `release_outbox`; Anchor treats them as remaining accounts.
- **Delegate with `DelegateConfig { validator: Some(<rollup validator identity>) }`.** Locally the identity is `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`; the SDK's default validator is a different key. Pass the validator as an instruction argument or an optional account, so it is never a hardcoded constant.
- **Delegated accounts must be committed now and then.** Lamports that are topped up, staked or withdrawn reach Solana only when the Player is committed. Set a `commit_frequency_ms` on Player delegation; the default from `DelegateConfig::default()` is acceptable.
- **The local stack needs two additions:**
  - It must create and fund the eSPL rent PDA (`initRentPdaIx`, 1 SOL), or top-ups fail with "insufficient lamports 300000, need 890880".
  - It must run a second `vrf-oracle` against the rollup (`--rpc-url http://127.0.0.1:7799 --websocket-url ws://127.0.0.1:7800`) for the ephemeral queue `Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT`.
- **Load programs at genesis.** `solana program deploy` of a default build is rejected locally. Use `--bpf-program`, as `local-stack.mjs` already does.

---

## Ground rules for every task

- **Formatting.** Never run bare `cargo fmt`. Format only the files you edited:
  - Program files: `rustfmt --edition 2021 --config max_width=120,use_small_heuristics=Max,reorder_imports=false <file>`
  - `crates/combat`: `--config max_width=180,use_small_heuristics=Max`
  - `tests/litesvm-suite/tests/game.rs` is hand-formatted. Never run rustfmt on it, and hand-wrap your edits to match.
- **Builds the suite needs** (from the repo root):
  ```bash
  cargo-build-sbf --manifest-path programs/mock-vrf/Cargo.toml
  cargo-build-sbf --manifest-path programs/horizon-zero/Cargo.toml -- --features inline-mock-vrf,inline-mock-magic
  cargo test -p horizon-litesvm-tests -- --test-threads=1
  ```
  `inline-mock-magic` is added in Task 3.
- **Docs.** AGENTS.md requires the chapter under `docs/src/` to change in the same commit as the behavior it describes. Each task lists the chapter it touches. Task 22 is a final sweep for anything missed, including diagrams. Build check: `mdbook build docs`.
- **Commits.** Commit after every task with a conventional prefix (`feat:`, `test:`, `docs:`, `chore:`), and no attribution lines.

---

### Task 1: Spike the outbox, PDA sponsor and VRF path on the local stack

This task decides whether the outbox design stands. Do it on a throwaway branch, and record the result before any other task.

**Files:**
- Create: `spike/outbox/` (a standalone Anchor program, excluded from the workspace)
- Create: `spike/outbox/run.mjs`
- Create: `docs/plans/2026-10-14-outbox-spike-result.md`

**Step 1: Branch**

```bash
git switch -c spike/outbox
```

**Step 2: Write a minimal program with five instructions**

`spike/outbox/programs/spike/src/lib.rs`. Use `#[ephemeral]` on the program module and depend on `ephemeral-rollups-sdk = { version = "0.17.3", features = ["anchor"] }`.

- `register` (Solana): creates `Holder [b"holder", owner]` (fields `owner`, `bump`) and `Outbox [b"outbox", owner]` (fields `owner`, `amount`, `bump`), funds Holder with 0.1 SOL, and delegates both using `#[delegate]` and `del`.
- `make_eph` (rollup): creates `[b"eph", owner]` with 64 bytes through `EphemeralAccount::new(holder, eph, vault).with_signer_seeds(&[holder_seeds, eph_seeds]).create(64)`.
- `withdraw(amount)` (rollup): moves `amount` lamports Holder → Outbox and sets `outbox.amount`. It then schedules `MagicIntentBundleBuilder::new(owner_signer, magic_context, magic_program).commit_and_undelegate(&[outbox]).add_post_undelegate_actions([CallHandler { destination_program: ID, accounts: [outbox (w), owner (w)], args: ActionArgs::new(release_outbox discriminator), escrow_authority: owner_signer, compute_units: 20_000 }]).build_and_invoke()`.
- `release_outbox` (Solana, permissionless): requires `outbox.owner == owner`, moves `outbox.amount` to `owner`, and sets `amount = 0`.
- `ping_vrf` (rollup): requests randomness on `DEFAULT_EPHEMERAL_TEST_QUEUE` with a callback that stores the seed in Holder.

**Step 3: Run it against the local stack**

```bash
pnpm localnet --no-build   # in one terminal: base 8899, rollup 7799 (check mb-stack output for the ER port)
node spike/outbox/run.mjs
```

`run.mjs` does the following:
1. Deploys the program, then calls `register` on Solana.
2. Waits until the rollup returns Holder.
3. Calls `make_eph` on the rollup.
4. Tops up Holder with the TS `lamportsDelegatedTransferIx` (0.05 SOL), then reads Holder's balance on the rollup.
5. Calls `withdraw(0.02 SOL)` on the rollup.
6. Polls Solana for up to 60 s until the Outbox is owned by the program and the owner's balance has gone up.
7. Calls `ping_vrf` and waits for the callback.

**Step 4: Record the answers**

Write `docs/plans/2026-10-14-outbox-spike-result.md` answering each question yes or no, with the log lines as evidence:

1. Does a PDA sponsor signing through `invoke_signed` create an ephemeral account?
2. Does `lamportsDelegatedTransferIx` credit Holder in the rollup, and what does it charge?
3. Does the post-undelegate action run with the Outbox owned by the program?
4. If the action fails, does a manual `release_outbox` on Solana succeed?
5. Does an ephemeral-queue VRF callback land in the rollup?
6. What are the exact rollup and VRF queue addresses on the local stack?

**Decision gate.** If (1) fails, stop and ask the user. If (3) fails but (4) works, keep the plan: the client calls `release_outbox`. If (3) and (4) both fail, switch Tasks 12 and 13 to the design's fallback (undelegate the Player account), and ask the user first.

**Step 5: Commit the result on main's feature branch**

```bash
git switch feat/ephemeral-rollup-fees
git checkout spike/outbox -- docs/plans/2026-10-14-outbox-spike-result.md
git commit -m "docs: record ephemeral rollup outbox spike result"
```

---

### Task 2: Pure fee math

**Files:**
- Create: `programs/horizon-zero/src/fees.rs`
- Modify: `programs/horizon-zero/src/lib.rs` (add `mod fees;` next to `mod error;`)

**Step 1: Write the failing tests**

`programs/horizon-zero/src/fees.rs`:

```rust
//! The protocol fee on a won battle. A draw pays no fee.

pub const DEFAULT_FEE_BPS: u16 = 500;
/// `initialize` and `set_fee` reject a higher rate.
pub const MAX_FEE_BPS: u16 = 1_000;

/// What a won battle moves: the loser pays `stake`, split between the winner and the protocol.
#[derive(Debug, PartialEq, Eq)]
pub struct WinPayout {
    /// To Config, rounded down.
    pub fee: u64,
    /// Lamports the loser's Player sends to the winner's Player: `stake - fee`.
    pub to_winner: u64,
    /// What the winner's budget or winnings grows by: `2 * stake - fee`.
    pub credit: u64,
}

pub fn win_payout(stake: u64, fee_bps: u16) -> WinPayout {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn five_percent_of_a_garrison_pot() {
        assert_eq!(
            win_payout(50_000_000, 500),
            WinPayout { fee: 5_000_000, to_winner: 45_000_000, credit: 95_000_000 }
        );
    }

    #[test]
    fn zero_fee_pays_the_whole_pot() {
        assert_eq!(win_payout(10_000_000, 0), WinPayout { fee: 0, to_winner: 10_000_000, credit: 20_000_000 });
    }

    #[test]
    fn fee_rounds_down() {
        // 2 * 3 * 333 / 10_000 = 0.1998
        assert_eq!(win_payout(3, 333).fee, 0);
        assert_eq!(win_payout(16, 333).fee, 1);
    }

    #[test]
    fn the_cap_never_takes_more_than_the_loser_stake() {
        let payout = win_payout(u64::MAX / 2, MAX_FEE_BPS);
        assert!(payout.fee <= u64::MAX / 2);
        assert_eq!(payout.to_winner + payout.fee, u64::MAX / 2);
    }
}
```

**Step 2: Run them and confirm they fail**

Run: `cargo test -p horizon-zero fees`
Expected: FAIL, panicked at `not yet implemented`.

**Step 3: Implement**

```rust
pub fn win_payout(stake: u64, fee_bps: u16) -> WinPayout {
    let pot = stake as u128 * 2;
    let fee = (pot * fee_bps.min(MAX_FEE_BPS) as u128 / 10_000) as u64;
    WinPayout { fee, to_winner: stake - fee, credit: (pot - fee as u128) as u64 }
}
```

`fee <= stake` holds because `MAX_FEE_BPS` is at most 5000. Add `const _: () = assert!(MAX_FEE_BPS <= 5_000);` above the function.

**Step 4: Run them and confirm they pass**

Run: `cargo test -p horizon-zero fees`
Expected: 4 passed.

**Step 5: Format and commit**

```bash
rustfmt --edition 2021 --config max_width=120,use_small_heuristics=Max,reorder_imports=false programs/horizon-zero/src/fees.rs
git add programs/horizon-zero/src/fees.rs programs/horizon-zero/src/lib.rs
git commit -m "feat: protocol fee math"
```

---

### Task 3: SDK dependency, mock feature and the ephemeral-account wrapper

**Files:**
- Modify: `programs/horizon-zero/Cargo.toml`
- Create: `programs/horizon-zero/src/eph.rs`
- Modify: `programs/horizon-zero/src/lib.rs` (`mod eph;`)

**Step 1: Dependencies and features**

In `programs/horizon-zero/Cargo.toml`:

```toml
[features]
# ...existing...
# LiteSVM has no magic or delegation program: ephemeral accounts become ordinary PDAs funded
# from the Player at Solana rent, and delegation and commit CPIs are skipped.
inline-mock-magic = []

[dependencies]
ephemeral-rollups-sdk = { version = "0.17.3", features = ["anchor"] }
```

Add `"ephemeral-rollups-sdk/idl-build"` to `idl-build` only if the crate defines that feature (`grep idl-build ~/.cargo/registry/src/*/ephemeral-rollups-sdk-0.17.3/Cargo.toml`).

Run: `cargo check -p horizon-zero`
Expected: compiles. If `compat::AccountInfo` doesn't unify with Anchor's `AccountInfo`, check which of `anchor-modern` or `anchor-compat` matches anchor-lang 1.0.1 in the SDK's `Cargo.toml`, and use that feature.

**Step 2: Write `eph.rs`**

```rust
//! Ephemeral accounts: rollup-only accounts whose rent a sponsor pays (see `ephemeral_accounts`).
//! Under `inline-mock-magic` they are ordinary PDAs funded from the sponsor at Solana rent, so
//! LiteSVM exercises the same instruction paths.

use anchor_lang::prelude::*;

/// Lamports `create(space)` takes from the sponsor.
pub fn rent(space: usize) -> Result<u64> {
    #[cfg(feature = "inline-mock-magic")]
    return Ok(Rent::get()?.minimum_balance(space));
    #[cfg(not(feature = "inline-mock-magic"))]
    return Ok(ephemeral_rollups_sdk::ephemeral_accounts::rent(space as u32));
}

/// Creates `account` owned by this program with `space` zero bytes, rent from `sponsor`.
/// Both are PDAs of this program and sign with their seeds.
pub fn create<'info>(
    sponsor: &AccountInfo<'info>,
    sponsor_seeds: &[&[u8]],
    account: &AccountInfo<'info>,
    account_seeds: &[&[u8]],
    vault: &AccountInfo<'info>,
    space: usize,
) -> Result<()> {
    #[cfg(not(feature = "inline-mock-magic"))]
    {
        ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount::new(sponsor, account, vault)
            .with_signer_seeds(&[sponsor_seeds, account_seeds])
            .create(space as u32)?;
    }
    #[cfg(feature = "inline-mock-magic")]
    {
        let _ = (sponsor_seeds, vault);
        crate::move_lamports(sponsor, account, rent(space)?)?;
        let system = |ix: anchor_lang::solana_program::instruction::Instruction| {
            anchor_lang::solana_program::program::invoke_signed(&ix, &[account.clone()], &[account_seeds])
        };
        system(anchor_lang::solana_program::system_instruction::allocate(account.key, space as u64))?;
        system(anchor_lang::solana_program::system_instruction::assign(account.key, &crate::ID))?;
    }
    Ok(())
}

/// Closes `account` and refunds its rent to `sponsor`.
pub fn close<'info>(
    sponsor: &AccountInfo<'info>,
    sponsor_seeds: &[&[u8]],
    account: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
) -> Result<()> {
    #[cfg(not(feature = "inline-mock-magic"))]
    {
        ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount::new(sponsor, account, vault)
            .with_signer_seeds(&[sponsor_seeds])
            .close()?;
    }
    #[cfg(feature = "inline-mock-magic")]
    {
        let _ = (sponsor_seeds, vault);
        crate::move_lamports(account, sponsor, account.lamports())?;
        account.resize(0)?;
        account.assign(&anchor_lang::system_program::ID);
    }
    Ok(())
}

/// Writes an Anchor account (discriminator and fields) into a freshly created account.
pub fn write<T: AccountSerialize>(account: &AccountInfo, value: &T) -> Result<()> {
    value.try_serialize(&mut &mut account.try_borrow_mut_data()?[..])
}
```

Make `move_lamports` in `lib.rs` `pub(crate)`.

**Step 3: Check it builds both ways**

```bash
cargo check -p horizon-zero
cargo check -p horizon-zero --features inline-mock-magic
```

Expected: both compile, with unused warnings only.

**Step 4: Commit**

```bash
git add programs/horizon-zero/Cargo.toml programs/horizon-zero/src/eph.rs programs/horizon-zero/src/lib.rs Cargo.lock
git commit -m "feat: ephemeral account wrapper with a LiteSVM mock"
```

---

### Task 4: New state: Config, Player, Outbox, Battle; drop Pot

**Files:**
- Modify: `programs/horizon-zero/src/state.rs`
- Modify: `programs/horizon-zero/src/error.rs`

**Step 1: Update the layout test first**

In `state.rs` `layout_tests::account_sizes_match_the_book`, add assertions for the new accounts and keep the existing ones:

```rust
assert_eq!(8 + Config::INIT_SPACE, 51); // admin 32, fee_bps 2, fees 8, bump 1
assert_eq!(8 + Player::INIT_SPACE, 76); // owner 32, budget 8, winnings 8, locked 8, segregate 1, fighting 2, bump 1
assert_eq!(8 + Outbox::INIT_SPACE, 49); // owner 32, amount 8, bump 1
assert_eq!(8 + Battle::INIT_SPACE, 2147); // + fee_bps 2
```

Run: `cargo test -p horizon-zero layout`
Expected: FAIL to compile (`Player` not found).

**Step 2: Change the state**

- `Config`: `admin`, `fee_bps: u16`, `fees: u64`, `bump`.
- Delete `Pot` and its `impl`. Add:

```rust
/// A wallet's one delegated account: `[b"player", owner]`. Its lamports above rent are the
/// player's money; the counters say how much of it is staked, locked or set aside, and the rest
/// (free) pays ephemeral rent for the player's armies, behaviors and battles.
#[account]
#[derive(InitSpace)]
pub struct Player {
    pub owner: Pubkey,
    /// Lamports a match may stake.
    pub budget: u64,
    /// Payouts set aside while `segregate` is on. A match never stakes them.
    pub winnings: u64,
    /// Stakes in battles that have not settled.
    pub locked: u64,
    pub segregate: bool,
    pub fighting: u16,
    pub bump: u8,
}

impl Player {
    pub fn credit(&mut self, lamports: u64) {
        if self.segregate {
            self.winnings += lamports;
        } else {
            self.budget += lamports;
        }
    }

    /// Lamports the counters do not claim: `lamports - rent - budget - winnings - locked`.
    pub fn free(&self, lamports: u64, rent: u64) -> u64 {
        lamports.saturating_sub(rent).saturating_sub(self.budget + self.winnings + self.locked)
    }
}

/// A one-shot cash-out account: `[b"outbox", owner]` per player, `[b"outbox", config]` for fees.
/// `release_outbox` pays `amount` to `owner` on Solana once the outbox is undelegated.
#[account]
#[derive(InitSpace)]
pub struct Outbox {
    pub owner: Pubkey,
    pub amount: u64,
    pub bump: u8,
}
```

- `Battle`: add `pub fee_bps: u16,` between `race_b` and `bump`. Change the doc on `BattleStatus::Seeded` to "The VRF seed is stored; anyone may settle."
- Add a unit test for `Player::free`:

```rust
#[test]
fn free_is_what_the_counters_leave() {
    let player = Player { owner: Pubkey::default(), budget: 30, winnings: 5, locked: 10, segregate: false, fighting: 1, bump: 0 };
    assert_eq!(player.free(100, 20), 35);
    assert_eq!(player.free(40, 20), 0);
}
```

**Step 3: Errors**

In `error.rs`, remove `NotCranked`, `BadCrank`, `PotTooLow`, `PotBusy` and `PotShort`, and add:

```rust
#[msg("Fee rate is above the cap")]
FeeTooHigh,
#[msg("Player budget does not cover the battleground stake")]
BudgetTooLow,
#[msg("Player has battles that have not settled")]
PlayerBusy,
#[msg("Player holds less than the amount asked for")]
BalanceShort,
#[msg("Player free balance does not cover the account rent")]
RentShort,
#[msg("Outbox still holds an unreleased withdrawal")]
OutboxBusy,
```

**Step 4: Run the tests**

Run: `cargo test -p horizon-zero layout free_is`
Expected: the state tests pass. `lib.rs` won't compile yet, because it still uses `Pot`. If so, run `cargo test -p horizon-zero --lib state::`, which fails at link too. In that case, finish Task 4 together with Task 5 before running, and commit them together.

**Step 5: Commit** (with Task 5 if needed)

```bash
git add programs/horizon-zero/src/state.rs programs/horizon-zero/src/error.rs
git commit -m "feat: Player, Outbox and fee fields replace Pot"
```

---

### Task 5: Remove Hydra and the crank

**Files:**
- Delete: `programs/horizon-zero/src/crank.rs`, `programs/mock-hydra/`, `app/scripts/hydra-cranker.mjs`
- Modify: `Cargo.toml` (remove `programs/mock-hydra` from `members`)
- Modify: `programs/horizon-zero/Cargo.toml` (drop `solana-instructions-sysvar`)
- Modify: `programs/horizon-zero/src/lib.rs`

**Step 1: Delete**

```bash
git rm -r programs/horizon-zero/src/crank.rs programs/mock-hydra app/scripts/hydra-cranker.mjs
```

**Step 2: In `lib.rs`**

- Remove `mod crank;`.
- `seed_match`: keep the status check and `battle_seeds`; then `battle.seed = randomness; battle.status = BattleStatus::Seeded;` and log `HZ_MATCH_SEEDED <battle> <seed hex>`.
- `SeedMatch` accounts: only `battle`.
- `request_vrf` metas: only `meta(battle, true)`.
- Remove the crank-fund block from `open_matched`.
- Leave `settle_match` for Task 9. For now delete the crank lines so it compiles.

**Step 3: Build**

Run: `cargo check -p horizon-zero --features inline-mock-vrf,inline-mock-magic`
Expected: errors only where `Pot` is used. Tasks 6 to 9 fix those.

**Step 4: Commit once Task 6 compiles** (one commit, "refactor: drop Hydra settlement crank")

---

### Task 6: initialize, set_fee, register_player, fund_budget, set_segregation

**Files:**
- Modify: `programs/horizon-zero/src/lib.rs`
- Modify: `tests/litesvm-suite/tests/game.rs` (hand-formatted), `tests/litesvm-suite/src/lib.rs`

**Step 1: Write the failing LiteSVM tests**

In `tests/litesvm-suite/src/lib.rs`, remove `HYDRA_ID`. In `game.rs`:

- Remove `hydra` from `Env`, the mock-hydra load, and the helpers `crank_keys`, `scheduled`, `hydra_create`, `trigger`, `crank_battle`.
- `initialize` data becomes `disc("initialize", &500u16.to_le_bytes())`.
- Add these helpers:

```rust
fn player_pda(env: &Env, owner: &Address) -> Address {
    pda(&[b"player", owner.as_ref()], &env.program).0
}

fn outbox_pda(env: &Env, owner: &Address) -> Address {
    pda(&[b"outbox", owner.as_ref()], &env.program).0
}

/// register_player(deposit): creates Player and Outbox and moves `deposit` into the Player.
fn register(env: &mut Env, owner: &Keypair, deposit: u64) {
    let accounts = vec![
        meta(owner.pubkey(), true, true),
        meta(player_pda(env, &owner.pubkey()), true, false),
        meta(outbox_pda(env, &owner.pubkey()), true, false),
        meta(address!("11111111111111111111111111111111"), false, false),
    ];
    send(&mut env.svm, owner, &[ix(env.program, accounts, disc("register_player", &deposit.to_le_bytes()))]);
}

fn player_ix(env: &Env, owner: &Keypair, name: &str, args: &[u8]) -> Instruction {
    let accounts = vec![meta(owner.pubkey(), true, true), meta(player_pda(env, &owner.pubkey()), true, false)];
    ix(env.program, accounts, disc(name, args))
}

/// (budget, winnings, locked, segregate, fighting), at the offsets in the accounts chapter.
fn player_state(env: &Env, owner: &Address) -> (u64, u64, u64, bool, u16) {
    let data = env.svm.get_account(&player_pda(env, owner)).unwrap().data;
    let u64_at = |at: usize| u64::from_le_bytes(data[at..at + 8].try_into().unwrap());
    (u64_at(40), u64_at(48), u64_at(56), data[64] == 1, u16::from_le_bytes([data[65], data[66]]))
}
```

Tests:

```rust
#[test]
fn fee_is_capped_and_only_the_admin_sets_it() {
    let mut env = setup();
    let set = |env: &Env, signer: &Keypair, bps: u16| {
        ix(env.program, vec![meta(signer.pubkey(), false, true), meta(env.config, true, false)], disc("set_fee", &bps.to_le_bytes()))
    };
    let admin = env.admin.insecure_clone();
    send_expect_reason_with(&mut env, &admin, |env| vec![set(env, &admin, 1_001)], "FeeTooHigh");
    let stranger = Keypair::new();
    env.fund(&stranger);
    send_expect_reason_with(&mut env, &stranger, |env| vec![set(env, &stranger, 100)], "NotAdmin");
    let ixs = vec![set(&env, &admin, 1_000)];
    send(&mut env.svm, &admin, &ixs);
    let data = env.svm.get_account(&env.config).unwrap().data;
    assert_eq!(u16::from_le_bytes([data[40], data[41]]), 1_000);
}

#[test]
fn register_then_fund_budget_moves_free_lamports_only() {
    let mut env = setup();
    let owner = Keypair::new();
    env.fund(&owner);
    register(&mut env, &owner, 100_000_000);
    assert_eq!(player_state(&env, &owner.pubkey()), (0, 0, 0, false, 0));
    let ixs = vec![player_ix(&env, &owner, "fund_budget", &60_000_000u64.to_le_bytes())];
    send(&mut env.svm, &owner, &ixs);
    assert_eq!(player_state(&env, &owner.pubkey()).0, 60_000_000);
    send_expect_reason_with(&mut env, &owner, |env| vec![player_ix(env, &owner, "fund_budget", &50_000_000u64.to_le_bytes())], "BalanceShort");
}
```

Run: build the program (see Ground rules), then `cargo test -p horizon-litesvm-tests fee_is_capped register_then -- --test-threads=1`
Expected: FAIL (unknown instruction).

**Step 2: Implement in `lib.rs`**

```rust
pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= fees::MAX_FEE_BPS, HorizonError::FeeTooHigh);
    ctx.accounts.config.admin = ctx.accounts.admin.key();
    ctx.accounts.config.fee_bps = fee_bps;
    ctx.accounts.config.fees = 0;
    ctx.accounts.config.bump = ctx.bumps.config;
    // ...identity creation unchanged...
}

pub fn set_fee(ctx: Context<AdminConfig>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= fees::MAX_FEE_BPS, HorizonError::FeeTooHigh);
    ctx.accounts.config.fee_bps = fee_bps;
    msg!("HZ_FEE {}", fee_bps);
    Ok(())
}

/// Creates the wallet's Player and Outbox on Solana, moves `deposit` into the Player, and (outside
/// LiteSVM) delegates both to the rollup.
pub fn register_player(ctx: Context<RegisterPlayer>, deposit: u64) -> Result<()> {
    let player = &mut ctx.accounts.player;
    player.owner = ctx.accounts.owner.key();
    player.bump = ctx.bumps.player;
    ctx.accounts.outbox.owner = ctx.accounts.owner.key();
    ctx.accounts.outbox.bump = ctx.bumps.outbox;
    transfer_sol(&ctx.accounts.owner, &ctx.accounts.player.to_account_info(), deposit)?;
    log_player(&ctx.accounts.player.key(), &ctx.accounts.player);
    Ok(())
}

pub fn fund_budget(ctx: Context<OwnPlayer>, amount: u64) -> Result<()> {
    let info = ctx.accounts.player.to_account_info();
    let rent = Rent::get()?.minimum_balance(info.data_len());
    let player = &mut ctx.accounts.player;
    require!(amount <= player.free(info.lamports(), rent), HorizonError::BalanceShort);
    player.budget += amount;
    log_player(&player.key(), player);
    Ok(())
}
```

`set_segregation` takes `Context<OwnPlayer>`. Accounts:

```rust
#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ HorizonError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct RegisterPlayer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Player::INIT_SPACE, seeds = [b"player", owner.key().as_ref()], bump)]
    pub player: Account<'info, Player>,
    #[account(init, payer = owner, space = 8 + Outbox::INIT_SPACE, seeds = [b"outbox", owner.key().as_ref()], bump)]
    pub outbox: Account<'info, Outbox>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnPlayer<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"player", owner.key().as_ref()], bump = player.bump, has_one = owner @ HorizonError::NotOwner)]
    pub player: Account<'info, Player>,
}

fn log_player(key: &Pubkey, player: &Player) {
    msg!(
        "HZ_PLAYER {} {} {} {} {} {} {}",
        key, player.owner, player.budget, player.winnings, player.locked, player.segregate as u8, player.fighting
    );
}
```

Delete `fund_pot`, `withdraw_pot`, `close_pot`, `pot_pda`, `log_pot`, `FundPot`, `OwnPot` and `ClosePot`.

Delegation is a separate instruction (Task 11), so `register_player` stays LiteSVM-testable. The client sends `register_player` and `delegate_player` in one transaction.

**Step 3: Rebuild and run**

Expected: both tests pass.

**Step 4: Docs.** In `docs/src/accounts.md`: update the Config layout (51 bytes); add the Player (76 bytes) and Outbox (49 bytes) layouts and their PDA rows; delete the Pot rows. Document `initialize(fee_bps)`, `set_fee`, `register_player`, `fund_budget` and `set_segregation`. Run `mdbook build docs`.

**Step 5: Commit**

```bash
git add -A programs tests docs/src Cargo.toml Cargo.lock
git commit -m "feat: Player account, admin fee rate, register and fund_budget"
```

---

### Task 7: Behaviors and armies as ephemeral accounts

**Files:**
- Modify: `programs/horizon-zero/src/lib.rs` (`create_behavior`, `create_army`, `close_army` and their account structs)
- Modify: `tests/litesvm-suite/tests/game.rs`

**Step 1: Failing test**

Change `Env::behavior` and the army helpers so they pass `[creator, creator's player (w), behavior (w), vault]`; the vault is any address under the mock. Register the creator first. Add:

```rust
#[test]
fn army_rent_comes_from_the_player_and_returns_on_close() {
    let mut env = setup();
    let owner = Keypair::new();
    env.fund(&owner);
    register(&mut env, &owner, 100_000_000);
    let player = player_pda(&env, &owner.pubkey());
    let before = env.svm.get_account(&player).unwrap().lamports;
    let behavior = env.behavior_by(&owner, &still_body());
    let army = env.create_army_for(&owner, 0, behavior);
    let mid = env.svm.get_account(&player).unwrap().lamports;
    assert!(mid < before, "the player paid the army and behavior rent");
    env.close_army(&owner, army);
    let behavior_rent = env.svm.get_account(&behavior).unwrap().lamports;
    assert_eq!(env.svm.get_account(&player).unwrap().lamports, before - behavior_rent);
}

#[test]
fn rent_cannot_dip_into_the_budget() {
    let mut env = setup();
    let owner = Keypair::new();
    env.fund(&owner);
    let rent = /* Player rent */ env.svm.minimum_balance_for_rent_exemption(76);
    register(&mut env, &owner, 10_000_000);
    let all = env.svm.get_account(&player_pda(&env, &owner.pubkey())).unwrap().lamports - rent;
    send(&mut env.svm, &owner, &[player_ix(&env, &owner, "fund_budget", &all.to_le_bytes())]);
    // behavior_by_ix builds the create_behavior instruction (step 2 of this task).
    send_expect_reason_with(&mut env, &owner, |env| vec![behavior_by_ix(env, &owner, &still_body())], "RentShort");
}
```

Rename the existing `behavior`, `create_army` and `close_army` helpers to take the owner where they don't already. Update every existing test caller to `register` that wallet first. Replace every `fund_pot` and `cover_stake` call with `register` plus `fund_budget`.

Expected: FAIL.

**Step 2: Implement**

A shared helper in `lib.rs`:

```rust
/// Creates an ephemeral account sponsored by `player`, after checking its free lamports cover the
/// rent so a stake or a payout is never spent on storage.
fn create_sponsored<'info>(
    player: &Account<'info, Player>,
    account: &AccountInfo<'info>,
    account_seeds: &[&[u8]],
    vault: &AccountInfo<'info>,
    space: usize,
) -> Result<()> {
    let info = player.to_account_info();
    let rent = Rent::get()?.minimum_balance(info.data_len());
    require!(player.free(info.lamports(), rent) >= eph::rent(space)?, HorizonError::RentShort);
    let bump = [player.bump];
    eph::create(&info, &[b"player", player.owner.as_ref(), &bump], account, account_seeds, vault, space)
}
```

- `create_behavior`: accounts are `creator: Signer`, `player` (mut, seeds `[b"player", creator]`), `behavior: UncheckedAccount` (mut), `vault: UncheckedAccount` (CHECK, `address = EPHEMERAL_VAULT_ID` when not mocked). Derive the PDA and bump with `find_program_address(&[b"behavior", &hash])`, require the key matches (`BadPda`), require `behavior.data_is_empty()`, then `create_sponsored(..., 8 + Behavior::INIT_SPACE)` and `eph::write(&behavior, &Behavior { .. })`.
- `create_army`: same pattern, with seeds `[b"army", owner, index_le]`.
- `close_army`: accounts are `owner`, `player` (mut), `army: Account<Army>` (mut, no `close =`), `vault`. Require Idle, then `eph::close(&player_info, player_seeds, &army_info, &vault)`. Anchor must not write `army` back after it's closed, so make it `UncheckedAccount` and deserialize it by hand with `Army::try_deserialize`. Check `owner` and status before closing.
- `update_army` doesn't change.

For the vault constraint, use a cfg'd constant:

```rust
#[cfg(not(feature = "inline-mock-magic"))]
pub const EPH_VAULT: Pubkey = Pubkey::new_from_array(ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID.to_bytes());
```

Under mock, skip the address check (`/// CHECK: unused under LiteSVM`). The cleanest way is a `#[cfg_attr(not(feature = "inline-mock-magic"), account(address = EPH_VAULT))]` on the field. If Anchor rejects `cfg_attr` on fields, check the address in the handler with `#[cfg(not(...))] require_keys_eq!`.

**Step 3: Run the whole suite**

Run: `cargo test -p horizon-litesvm-tests -- --test-threads=1`
Expected: the two new tests pass. Tests that touch locking or settlement may still fail; Tasks 8 and 9 fix them.

**Step 4: Docs.** In `accounts.md`, mark Army and Behavior as ephemeral, give their sponsor and rent formula, and update the `create_behavior`, `create_army` and `close_army` account lists.

**Step 5: Commit** ("feat: behaviors and armies are ephemeral accounts sponsored by the player")

---

### Task 8: lock_army against Player budgets

**Files:**
- Modify: `programs/horizon-zero/src/lib.rs` (`lock_army`, `open_matched`, `queued_opponents`, `LockArmy`, `write_battle`)
- Modify: `tests/litesvm-suite/tests/game.rs` (`lock_ix`, `locking_needs_a_pot...` → `locking_needs_a_budget_that_covers_the_stake_and_unlock_dequeues`, `one_pot_backs_many_armies...` → `one_player_backs_many_armies_until_it_runs_dry`)

**Step 1: Update the tests first**

`lock_ix` passes `[player signer, player account (w), battleground (w), army (w), battle (w), vault, oracle_queue (w), program_identity, vrf program, slot_hashes, system]`, in the order `#[vrf]` adds them (copy the current order from `lock_ix`, and replace the pot with the player account). Remaining accounts are the behaviors, then each candidate army (w), then each candidate owner's **Player** (w).

Assertions after a match: both players have `locked == stake` and `budget` down by `stake`, both Player lamport balances are unchanged apart from the locker's Battle rent, and the battle's `fee_bps` byte is 500.

Expected: FAIL.

**Step 2: Implement**

- `LockArmy`: replace `pot` with `player_account: Box<Account<'info, Player>>` (mut, seeds `[b"player", player.key()]`) and add `vault`.
- `require!(player_account.budget >= stake, BudgetTooLow)`.
- `queued_opponents`: look for program-owned accounts with `data_len() == 8 + Player::INIT_SPACE` that deserialize as `Player` with `budget >= stake`. Delegated accounts in the rollup are owned by this program there, so the owner check stands.
- `open_matched`: create the Battle with `create_sponsored(&player_account, battle, &[b"match", ground, seq, bump], vault, 8 + Battle::INIT_SPACE)` instead of `create_program_account_with_lamports`. Pass `fee_bps: ctx.accounts.config.fee_bps` into `BattleHead`, which means adding `config: Account<Config>` to `LockArmy`, and have `write_battle` serialize it after `race_b`. For both players: `budget -= stake; locked += stake; fighting += 1`. Remove both `move_lamports` stake calls. Log `HZ_PLAYER` for both.
- `request_vrf`: queue unchanged in code; the client passes the ephemeral queue.

**Step 3: Run the suite** and confirm the locking tests pass.

**Step 4: Docs.** In `accounts.md`, update the `lock_army` account list and remaining accounts and the Battle layout (2147 bytes, `fee_bps` at offset 2144). In `matchmaking.md`, add the stake locking (counters only) and remove all Pot text.

**Step 5: Commit** ("feat: lock_army stakes from the Player budget")

---

### Task 9: settle_match pays the fee and closes the battle

**Files:**
- Modify: `programs/horizon-zero/src/lib.rs` (`settle_match`, `SettleMatch`)
- Modify: `tests/litesvm-suite/tests/game.rs` (`match_pays_the_simulated_winner_and_a_draw_refunds`, `segregated_payouts_...`, `full_armies_resolve_on_every_battleground`, `cu_benchmark`)

**Step 1: Tests first**

Replace `crank_battle` with `settle(env, battle)`, which sends `cu_limit()` and `settle_match` from a fresh payer. Its accounts are `battle (w), army_a (w), army_b (w), player_a account (w), player_b account (w), config (w), vault`. In `match_pays_the_simulated_winner_and_a_draw_refunds`, assert:

```rust
let payout = horizon_zero_fee(STAKE, 500); // copy of fees::win_payout in the test crate, or assert literal numbers
// winner: lamports +to_winner, budget +credit (from post-lock budget), locked 0
// loser:  lamports -STAKE, locked 0, budget unchanged from post-lock
// config: lamports +fee, fees field (offset 42) == fee
// draw:   lamports unchanged for both, budget back to pre-lock, config fees unchanged
// battle account: gone (lamports 0) after settle; locker's Player got the battle rent back
assert!(env.svm.get_account(&battle).map_or(true, |a| a.lamports == 0));
```

With `STAKE` = 10,000,000 (Task 15 changes the constant), use literals: fee 1,000,000, to_winner 9,000,000, credit 19,000,000.

Add:

```rust
#[test]
fn a_second_settle_fails() {
    // lock_and_seed, settle once, then the same settle instruction again must fail (the battle is closed).
}
```

Expected: FAIL.

**Step 2: Implement**

```rust
/// Plays the battle on the stored seed and pays out. Anyone may call it once the battle is seeded.
pub fn settle_match(ctx: Context<SettleMatch>) -> Result<()> {
    let battle_key = ctx.accounts.battle.key();
    let battle = &ctx.accounts.battle;
    require!(battle.status == BattleStatus::Seeded, HorizonError::AlreadyResolved);
    require!(ctx.accounts.army_a.status == ArmyStatus::Fighting, HorizonError::BadStatus);
    require!(ctx.accounts.army_b.status == ArmyStatus::Fighting, HorizonError::BadStatus);
    battle_seeds(battle, &battle_key)?;
    // ...simulate_winner exactly as before...
    let stake = battle.stake;
    let (outcome, fee) = match winner {
        Some(side) => {
            let payout = fees::win_payout(stake, battle.fee_bps);
            let (winner, loser) = match side {
                Side::A => (&mut ctx.accounts.player_a, &mut ctx.accounts.player_b),
                Side::B => (&mut ctx.accounts.player_b, &mut ctx.accounts.player_a),
            };
            move_lamports(&loser.to_account_info(), &winner.to_account_info(), payout.to_winner)?;
            move_lamports(&loser.to_account_info(), &ctx.accounts.config.to_account_info(), payout.fee)?;
            winner.credit(payout.credit);
            (if side == Side::A { Outcome::A } else { Outcome::B }, payout.fee)
        }
        None => {
            ctx.accounts.player_a.budget += stake;
            ctx.accounts.player_b.budget += stake;
            (Outcome::Draw, 0)
        }
    };
    ctx.accounts.config.fees += fee;
    for player in [&mut ctx.accounts.player_a, &mut ctx.accounts.player_b] {
        player.locked -= stake;
        player.fighting = player.fighting.saturating_sub(1);
        log_player(&player.key(), player);
    }
    ctx.accounts.army_a.status = ArmyStatus::Idle;
    ctx.accounts.army_b.status = ArmyStatus::Idle;
    let seed = battle.seed;
    msg!("HZ_MATCH_RESOLVED {} {} {} {} {}", battle_key, outcome as u8, fee, hex32(&seed), battle.player_b);
    // The locker (player B) sponsored the battle; closing refunds its rent.
    let sponsor = ctx.accounts.player_b.to_account_info();
    let bump = [ctx.accounts.player_b.bump];
    let owner = ctx.accounts.player_b.owner;
    eph::close(&sponsor, &[b"player", owner.as_ref(), &bump], &ctx.accounts.battle.to_account_info(), &ctx.accounts.vault)?;
    Ok(())
}
```

`SettleMatch`:
- `battle: UncheckedAccount`, deserialized by hand into a local `Box<Battle>`, because it gets closed.
- `army_a` and `army_b` as before.
- `player_a` and `player_b`: `Box<Account<Player>>` with seeds `[b"player", battle.player_a]` and `[b"player", battle.player_b]`. Since `battle` is unchecked, check these in the handler with `verify_pda` against the deserialized battle.
- `config`: mut, seeds `[b"config"]`.
- `vault`.

Remove the `instructions` sysvar.

The battle's status never becomes Resolved, because the account is gone. Leave the `Resolved` variant in place, since the indexer still writes `1` from the log. Keep the `cu-profile` hooks where they were.

**Step 3: Run the suite and the benchmark**

```bash
cargo test -p horizon-litesvm-tests -- --test-threads=1
cargo test -p horizon-litesvm-tests cu_benchmark -- --ignored --nocapture
```

Expected: all pass, and the benchmark's maximum stays under 1,400,000.

**Step 4: Docs.** In `accounts.md`, update the `settle_match` account list, closing and log line, and the Battle state diagram (`Seeded --> [*]: settle_match closes it`). In `matchmaking.md`, replace the "Settlement crank" section with "Settlement and fee", including the payout formulas and the Garrison example. In `overview.md`, update the payout paragraph and remove the Hydra lines.

**Step 5: Commit** ("feat: permissionless settle_match takes the protocol fee")

---

### Task 10: withdraw, release_outbox, claim_fees

**Files:**
- Modify: `programs/horizon-zero/src/lib.rs`
- Modify: `tests/litesvm-suite/tests/game.rs`

**Step 1: Failing tests**

```rust
#[test]
fn withdraw_takes_free_then_winnings_then_budget_and_release_pays_the_owner() {
    // register 100_000_000, fund_budget 40_000_000, set winnings via a segregated win (or skip: free+budget only)
    // withdraw 70_000_000: free (~60_000_000 minus rent) first, then budget
    // outbox.amount == 70_000_000; release_outbox from a stranger pays the owner, outbox.amount == 0
    // a second withdraw before release fails with OutboxBusy (mock: amount != 0)
}

#[test]
fn withdraw_never_touches_locked_stakes() {
    // lock a match, then withdraw everything but 1 lamport of locked: BalanceShort
}

#[test]
fn only_the_admin_claims_fees_and_release_pays_the_admin() {
    // settle a won battle, claim_fees by a stranger: NotAdmin
    // claim_fees by admin: config.fees == 0, treasury outbox amount == fee, release pays admin
}
```

Write these out in full in `game.rs`, using the helpers from Tasks 6 to 9.

Expected: FAIL.

**Step 2: Implement**

```rust
/// Moves `amount` to the owner's Outbox, taken from free lamports, then winnings, then budget,
/// never from locked stakes, and schedules the Outbox's commit and undelegation. On Solana,
/// `release_outbox` pays it out.
pub fn withdraw<'info>(ctx: Context<'_, '_, '_, 'info, Withdraw<'info>>, amount: u64) -> Result<()> {
    require!(ctx.accounts.outbox.amount == 0, HorizonError::OutboxBusy);
    let info = ctx.accounts.player.to_account_info();
    let rent = Rent::get()?.minimum_balance(info.data_len());
    let player = &mut ctx.accounts.player;
    let free = player.free(info.lamports(), rent);
    require!(amount <= free + player.winnings + player.budget, HorizonError::BalanceShort);
    let rest = amount.saturating_sub(free);
    let from_winnings = rest.min(player.winnings);
    player.winnings -= from_winnings;
    player.budget -= rest - from_winnings;
    move_lamports(&info, &ctx.accounts.outbox.to_account_info(), amount)?;
    ctx.accounts.outbox.amount = amount;
    log_player(&player.key(), player);
    msg!("HZ_WITHDRAW {} {}", ctx.accounts.outbox.key(), amount);
    schedule_release(&ctx.accounts.owner.to_account_info(), &ctx.accounts.outbox, ctx.accounts.owner.key(), &ctx.accounts.magic)?;
    Ok(())
}

/// Admin only: moves the claimable fees to the treasury Outbox `[b"outbox", config]`.
pub fn claim_fees<'info>(ctx: Context<'_, '_, '_, 'info, ClaimFees<'info>>) -> Result<()> {
    require!(ctx.accounts.outbox.amount == 0, HorizonError::OutboxBusy);
    let fees = ctx.accounts.config.fees;
    ctx.accounts.config.fees = 0;
    move_lamports(&ctx.accounts.config.to_account_info(), &ctx.accounts.outbox.to_account_info(), fees)?;
    ctx.accounts.outbox.owner = ctx.accounts.admin.key();
    ctx.accounts.outbox.amount = fees;
    msg!("HZ_CLAIM {} {}", ctx.accounts.outbox.key(), fees);
    schedule_release(&ctx.accounts.admin.to_account_info(), &ctx.accounts.outbox, ctx.accounts.admin.key(), &ctx.accounts.magic)?;
    Ok(())
}

/// Solana, permissionless: pays an undelegated Outbox's amount to its owner.
pub fn release_outbox(ctx: Context<ReleaseOutbox>) -> Result<()> {
    let amount = ctx.accounts.outbox.amount;
    ctx.accounts.outbox.amount = 0;
    move_lamports(&ctx.accounts.outbox.to_account_info(), &ctx.accounts.owner.to_account_info(), amount)?;
    msg!("HZ_RELEASE {} {}", ctx.accounts.outbox.key(), amount);
    Ok(())
}
```

`schedule_release`:
- Under `inline-mock-magic`, it does nothing: the test calls `release_outbox` directly, because the Outbox is never delegated there.
- Otherwise it builds `MagicIntentBundleBuilder::new(payer, magic_context, magic_program).commit_and_undelegate(&[outbox]).add_post_undelegate_actions([CallHandler { .. release_outbox .. }]).build_and_invoke()`, exactly as proven in Task 1. Before writing it, read the spike's `withdraw` and copy its account list.

**The spike overrides the code above** (see "Spike findings" at the top). Split each instruction:

- `fund_outbox(amount)` holds the lamport and counter logic shown for `withdraw`, with a typed Outbox.
- `withdraw()` only checks `amount != 0` on an `UncheckedAccount` Outbox (`seeds = [b"outbox", owner]`), then calls `schedule_release`.
- Likewise, `fund_treasury_outbox()` (admin) holds the fee move, and `claim_fees()` only schedules.

The LiteSVM tests call `fund_outbox` and then `release_outbox` directly. Under mock, `withdraw` and `claim_fees` do nothing beyond their checks.

Accounts:
- `Withdraw`: `owner` (signer, mut), `player` (mut, seeds), `outbox` (mut, seeds `[b"outbox", owner]`, `has_one = owner`), and `magic: MagicAccounts` (a nested struct with `magic_context` (mut) and `magic_program`; both `UncheckedAccount`, with addresses checked when not mocked).
- `ClaimFees`: `admin` (signer, mut), `config` (mut, `has_one = admin`), `outbox` (mut, seeds `[b"outbox", config.key()]`), and `magic`.
- `ReleaseOutbox`: `outbox` (mut), and `owner: SystemAccount` (mut, `address = outbox.owner`).

The treasury Outbox is created by a new admin instruction, `init_treasury_outbox` (Solana: init `[b"outbox", config]`, owner = admin). It's delegated in Task 11.

**Step 3: Run the suite** and confirm all pass.

**Step 4: Docs.** In `matchmaking.md`, add a new section "Money in and out" covering the free/budget/winnings/locked split, top-up, withdraw, release and claim, with a mermaid sequence diagram (rollup → magic program → delegation program → `release_outbox`). Add the instructions to `accounts.md`.

**Step 5: Commit** ("feat: withdraw and fee claims through an undelegated outbox")

---

### Task 11: Delegation instructions and the `#[ephemeral]` program

**Files:**
- Modify: `programs/horizon-zero/src/lib.rs`

These need the delegation program, so LiteSVM can't run them. They're compiled out under `inline-mock-magic`, and Task 18 tests them.

**Step 1: Implement**

- Put `#[ephemeral]` (from `ephemeral_rollups_sdk::anchor`) on `pub mod horizon_zero` under `#[cfg_attr(not(feature = "inline-mock-magic"), ephemeral)]`. It adds the undelegation callback the delegation program calls.
- Add one instruction per kind, following the SDK's `#[delegate]` pattern with `del` on an `UncheckedAccount` and `ctx.accounts.delegate_pda(payer, seeds, DelegateConfig::default())`:
  - `delegate_player`, signed by the owner, seeds `[b"player", owner]`.
  - `delegate_outbox`, signed by the owner, seeds `[b"outbox", owner]`. It requires `outbox.amount == 0` (read before delegating), so an unreleased withdrawal can't be locked back into the rollup.
  - `delegate_config`, admin only, seeds `[b"config"]`.
  - `delegate_battleground(id)`, admin only.
  - `delegate_treasury_outbox`, admin only, seeds `[b"outbox", config]`. Same `amount == 0` rule.
- Gate all five with `#[cfg(not(feature = "inline-mock-magic"))]`. If Anchor's `#[program]` won't accept cfg on handlers, keep them and make the handler body `return err!(HorizonError::MissingAccount)` under mock.

**Step 2: Build both variants**

```bash
cargo-build-sbf --manifest-path programs/horizon-zero/Cargo.toml
cargo-build-sbf --manifest-path programs/horizon-zero/Cargo.toml -- --features inline-mock-vrf,inline-mock-magic
cargo test -p horizon-litesvm-tests -- --test-threads=1
```

Expected: both builds succeed and the suite passes.

**Step 3: Docs.** In `accounts.md`, add the delegate instructions and a "Where each account lives" table (Solana and delegated versus ephemeral).

**Step 4: Commit** ("feat: delegate player, outbox, config and battlegrounds to the rollup")

---

### Task 12: Content stakes 0.01, 0.05, 0.1

**Files:**
- Modify: `content/catalog.json` (the `battlegrounds[].stake` values)
- Modify: `tests/litesvm-suite/tests/game.rs` (`STAKE` and `create_battleground` calls)
- Modify: `docs/src/overview.md` (battleground table)

**Step 1.** Set the stakes to `10000000`, `50000000` and `100000000`. In `game.rs`, set `STAKE = 10_000_000` and change the setup calls to `50_000_000` and `100_000_000`. Recompute the Task 9 literals (fee 1,000,000, to_winner 9,000,000, credit 19,000,000).

**Step 2.** Run `cargo test -p horizon-litesvm-tests -- --test-threads=1` and `pnpm --filter app test`.
Expected: pass. If a golden test pins stakes, update its fixture, and say so in the commit body.

**Step 3.** In the `overview.md` table, set the SOL column to 0.01, 0.05 and 0.1 and the lamports to match.

**Step 4: Commit** ("feat: stake tiers 0.01, 0.05 and 0.1 SOL")

---

### Task 13: Client codec

**Files:**
- Modify: `app/src/codec.ts`
- Modify: `app/package.json` (add `@magicblock-labs/ephemeral-rollups-sdk`; pin the version the spike used)

**Step 1.** Replace `potPda`, `decodePot`, `fundPotIx`, `withdrawPotIx` and `crankFundPda` with:
- `playerPda(owner)`, `outboxPda(owner)`, `treasuryOutboxPda()`
- `decodePlayer(data)`, which returns `{ budget, winnings, locked, segregate, fighting }` as strings and numbers, at offsets 40/48/56/64/65
- `decodeConfig(data)`, which returns `{ admin, feeBps, fees }` at offsets 8/40/42
- `registerPlayerIx(owner, deposit)`, `delegatePlayerIx(owner)`, `delegateOutboxIx(owner)`, `fundBudgetIx(owner, lamports)`, `withdrawIx(owner, lamports)`, `releaseOutboxIx(outbox, owner)`, `claimFeesIx(admin)`, `setFeeIx(admin, bps)`, `settleMatchIx(match)`
- `setSegregationIx(owner, segregate)` (no battleground argument)

Build each instruction's account list from the program's account struct, in order. The delegate instructions also pass the delegation buffer, record and metadata PDAs; derive them with the TS SDK helpers (`delegationRecordPdaFromDelegatedAccount` and similar).

Update `createBehaviorIx`, `createArmyIx` and `lockArmyIx` to pass the player account and vault (`EPHEMERAL_VAULT_ID` from the TS SDK). `lockArmyIx` also passes Config, and passes opponents' Player PDAs instead of pots.

**Step 2.** Run `pnpm --filter app build` (it runs `tsc --noEmit`).
Expected: only errors in files that Tasks 14 to 16 change.

**Step 3: Commit** with Task 14.

---

### Task 14: Client chain adapter on two connections

**Files:**
- Modify: `app/src/network.ts`
- Modify: `app/src/devChain.ts` (`ChainAdapter` type)
- Modify: `app/src/solanaChain.ts`

**Step 1: Network.** Add `ER_RPC_URL` (`VITE_ER_RPC_URL`, falling back to the local rollup port from Task 1 in dev and to MagicBlock's devnet rollup URL otherwise). Set `ORACLE_QUEUE` to the ephemeral queue: `DEFAULT_EPHEMERAL_TEST_QUEUE` locally and `DEFAULT_EPHEMERAL_QUEUE` (`5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc`) otherwise.

**Step 2: Adapter type.** Replace the pot methods with:

```ts
export type PlayerBalance = { free: string; budget: string; winnings: string; locked: string; segregate: boolean; outboxPending: string };
// ChainAdapter
player(): Promise<PlayerBalance | null>;            // null before register
register(depositLamports: bigint): Promise<void>;   // base: register + delegate player + delegate outbox
topUp(lamports: bigint): Promise<void>;             // base: lamportsDelegatedTransferIx
fundBudget(lamports: bigint): Promise<void>;        // ER
withdraw(lamports: bigint): Promise<void>;          // base delegate_outbox if needed, then ER withdraw
setSegregation(segregate: boolean): Promise<void>;  // ER
settle(match: Match): Promise<void>;                // ER
admin(): Promise<{ admin: string; feeBps: number; fees: string } | null>;
claimFees(): Promise<void>;                          // ER
setFee(bps: number): Promise<void>;                  // ER
```

**Step 3: `solanaChain.ts`.**
- Keep two `Connection`s, `base` and `er`, with `send(tx, connection)`. Rollup transactions still need the wallet to sign. Fetch the blockhash from the rollup connection.
- `free` is computed from the account's lamports and its rent (`getMinimumBalanceForRentExemption(76)` on `base`).
- `outboxPending` is the Outbox `amount` read from Solana when the Outbox isn't owned by the delegation program; if it's non-zero, call `releaseOutboxIx` from the wallet.
- After `lock`, poll the battle on the rollup until it's Seeded (status byte 2), then call `settle`.
- `armies()` checks liveness on the rollup connection.

**Step 4.** Run `pnpm --filter app build`. Expected: errors only in `App.tsx` and `localChain.ts`.

**Step 5: Commit** ("feat: client talks to Solana and the rollup")

---

### Task 15: Dev mode and the local ledger

**Files:**
- Modify: `app/local-ledger.mjs`, `app/local-ledger.test.mjs`, `app/src/localChain.ts`

**Step 1: Tests first.** In `local-ledger.test.mjs`, replace the pot tests with:
- Registering, then `fundBudget`, keeps `free + budget` equal to the deposit.
- A won match credits the winner `2 * stake - fee` and records `fee` in a `config` row.
- A draw restores both budgets.
- `withdraw` takes free, then winnings, then budget, and refuses locked stakes.
- `claimFees` zeroes the fees.

Use a 5% default fee. Run `pnpm --filter app test` and confirm the failures.

**Step 2: Implement.**
- Replace the `pots` table with `players (owner PRIMARY KEY, balance, budget, winnings, locked, segregate, fighting)`, where `balance` is the lamports and has no rent, and add a `config (fee_bps, fees)` row.
- Port the Task 2 fee math into a `winPayout` function in the ledger.
- Mirror the program's rules and error strings (`BalanceShort`, `BudgetTooLow`, `FeeTooHigh`).
- Expose the new adapter methods in `localChain.ts`. `topUp` adds to `balance`; `register` creates the row.

**Step 3.** Run `pnpm --filter app test`. Expected: pass.

**Step 4: Docs.** In `client.md`, update the dev mode section.

**Step 5: Commit** ("feat: dev ledger mirrors the player balance and fee")

---

### Task 16: App UI

**Files:**
- Modify: `app/src/App.tsx` (and `app/src/ui.tsx` if the panel lives there)

**Step 1.** Replace the per-battleground pot panel with one wallet panel:
- Rows: Free, Budget, Winnings, Locked.
- Buttons: Top up, Fund budget and Withdraw, each with an amount field, plus the segregation toggle.
- A note under Top up: "MagicBlock charges 0.0003 SOL per top-up."
- A note under Withdraw: "Each withdrawal costs about 0.0003 SOL in rollup fees."
- While `outboxPending > 0`, Withdraw is disabled and shows "Withdrawal in flight".

Show a first-run Create player step with a deposit field when `player()` returns null. Show an Admin section only when `admin()?.admin` equals the wallet: the fee rate input (bps, at most 1000), Set fee, the claimable fees, and Claim fees.

**Step 2.** Run `pnpm --filter app build`, then the dev preview (`preview_start` with the app's dev config, `VITE_DEV_MODE=true`). Check the panel, the first-run step and a fight with settlement. Check the console for errors.

**Step 3: Docs.** In `client.md`, document the wallet panel, first run, admin view, settle-after-seed and the two connections. Update any diagram there.

**Step 4: Commit** ("feat: wallet panel, first-run player and admin fee view")

---

### Task 17: Indexer

**Files:**
- Modify: `indexer/src/decode.rs`, `indexer/src/sources.rs`, `indexer/src/store.rs`, `indexer/src/main.rs`

**Step 1: Tests first.** In `decode.rs`'s test module (create one if missing), add the following. Run `cargo test --manifest-path indexer/Cargo.toml`; it fails.
- A Battle of 2147 bytes decodes, with `fee_bps` read.
- A 76-byte Player decodes.
- A Pot-sized account is ignored.
- `parse_resolved("HZ_MATCH_RESOLVED <battle> 1 1000000 <hex> <player_b>")` returns `(battle, 1, 1_000_000)`.

**Step 2: Implement.**
- In the decoder, Pot becomes Player, and Battle gets `fee_bps`.
- Add a `logsSubscribe` (`mentions: [program]`) datasource in `sources.rs`, with the same retry loop as `programSubscribe`.
- On `HZ_MATCH_RESOLVED`, the store updates the battle row: status 1, outcome, fee.
- Add a `fee` column to the matches table with a migration `ALTER TABLE ... ADD COLUMN fee TEXT`, guarded the way existing columns are.
- Return `fee` from `/matches`.

**Step 3.** Run `cargo test --manifest-path indexer/Cargo.toml`. Expected: pass.

**Step 4: Docs.** In `indexer.md`, point `SOLANA_RPC_URL` at the rollup, add the logs datasource to the mermaid diagram, and replace "HZ_ logs are not read" with the resolved-log rule.

**Step 5: Commit** ("feat: indexer reads the rollup and resolved-battle logs")

---

### Task 18: Local stack, bootstrap and end-to-end check

**Files:**
- Modify: `scripts/local-stack.mjs`, `app/scripts/bootstrap.mjs`, `app/scripts/localnet-assert.mjs`, `scripts/dev-all.mjs` (if it starts the cranker), `render.yaml` (indexer RPC env), `.env.example`

**Step 1.**
- `local-stack.mjs`: remove the mock-hydra build, load and cranker, and the `HZ_HYDRA_*` handling. Print the rollup URL, and export it to the app (`VITE_ER_RPC_URL`) and the indexer (`SOLANA_RPC_URL`).
- `bootstrap.mjs`: run `initialize(500)`, the battlegrounds from the catalog, `init_treasury_outbox`, `delegate_config`, `delegate_battleground` for each, and `delegate_treasury_outbox`, then wait until the rollup returns Config.
- `localnet-assert.mjs` (`--check`):
  1. Two wallets register.
  2. Each tops up 0.05 SOL.
  3. Each funds 0.02 SOL of budget.
  4. Each creates a behavior and an army on Outpost.
  5. Both lock, then the battle is seeded and settled.
  6. Assert the winner's and loser's balances and the config fees.
  7. The winner withdraws 0.01 SOL. Wait for the Outbox to undelegate and `release_outbox` to pay out, then assert the wallet balance rose.
  8. The admin claims fees and receives them.

**Step 2.** Run:

```bash
pnpm localnet --check
```

Expected: the battle settles, the withdrawal arrives, and the fee claim arrives, then exit 0. Fix anything the spike didn't catch, and add each fix to its task's docs.

**Step 3: Docs.** In `deployment.md`, cover the local stack without Hydra, the bootstrap delegation steps, the rollup URL, and devnet and mainnet needing `VITE_ER_RPC_URL` and the ephemeral queue. In `testing.md`, remove the Hydra suite text, add `inline-mock-magic` and what it mocks, update the CI steps, and describe what `--check` now covers.

**Step 4: Commit** ("feat: local stack plays and cashes out through the rollup")

---

### Task 19: CI

**Files:**
- Modify: `.github/workflows/*.yml` (the job that builds mock-hydra and the program)

**Step 1.** Drop the mock-hydra build and build the program with `--features inline-mock-vrf,inline-mock-magic`. Push the branch, or run the steps locally in the order from Ground rules.

**Step 2: Commit** ("ci: build without Hydra, with the magic mock")

---

### Task 20: Final docs sweep and verification

**Step 1.** Find everything that still describes the old model:

```bash
grep -rniE "pot|hydra|crank|fund_pot|withdraw_pot|close_pot|cranker" docs/src app/src indexer/src scripts app/scripts | grep -viE "potential|spot|depot"
```

Fix every hit that describes removed behavior. Check every mermaid block in `overview.md`, `accounts.md`, `matchmaking.md`, `client.md` and `indexer.md` against the new accounts: no Pot, Hydra, Cranker or Vault nodes, and add Player, Outbox, Treasury outbox and the rollup.

**Step 2.** Run all of these:

```bash
mdbook build docs
cargo test -p combat
cargo-build-sbf --manifest-path programs/mock-vrf/Cargo.toml
cargo-build-sbf --manifest-path programs/horizon-zero/Cargo.toml -- --features inline-mock-vrf,inline-mock-magic
cargo test -p horizon-litesvm-tests -- --test-threads=1
cargo test --manifest-path indexer/Cargo.toml
pnpm --filter app test
pnpm --filter app build
pnpm localnet --check
```

Expected: all pass. Paste the summary lines into the final report.

**Step 3: Commit** ("docs: sync the book with rollup gameplay and the protocol fee")

**Step 4.** Use superpowers:finishing-a-development-branch.
