use anchor_lang::prelude::*;
use anchor_lang::system_program;
#[cfg(not(feature = "inline-mock-magic"))]
use ephemeral_rollups_sdk::anchor::{delegate, ephemeral};
use ephemeral_vrf_sdk::anchor::{vrf, vrf_callback};
use ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID;
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;
use horizon_combat::{
    behavior_hash, simulate_winner, Aim, BehaviorBody, Effect, Geometry, Side, SnapshotUnit as CombatUnit,
    MAX_BEHAVIOR_LEN, ZONE_DEPTH,
};

mod eph;
mod error;
pub mod fees;
mod state;

use error::HorizonError;
use state::*;

declare_id!("zeroDcScmnx7TSvWvnKBa81Gcq34T1QSRWH182YdqRg");

/// Collects ephemeral rent in the rollup. Unchecked under LiteSVM, where nothing reads it.
#[cfg(not(feature = "inline-mock-magic"))]
pub const EPH_VAULT: Pubkey = Pubkey::new_from_array(ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID.to_bytes());
/// Creates and closes ephemeral accounts in the rollup. Unchecked under LiteSVM.
#[cfg(not(feature = "inline-mock-magic"))]
pub const MAGIC_PROGRAM: Pubkey = Pubkey::new_from_array(ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID.to_bytes());
/// Queues the rollup's commits. Unchecked under LiteSVM.
#[cfg(not(feature = "inline-mock-magic"))]
pub const MAGIC_CONTEXT: Pubkey = Pubkey::new_from_array(ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID.to_bytes());
/// Owns a delegated account's Solana copy. LiteSVM delegates nothing, but the hand-read of Config
/// accepts this owner in both builds, so the tests can stand in for a delegated Config.
pub const DELEGATION_PROGRAM: Pubkey =
    Pubkey::new_from_array(ephemeral_rollups_sdk::consts::DELEGATION_PROGRAM_ID.to_bytes());

// `VALIDATOR`, the rollup validator identity every delegate instruction delegates to, and
// `ORACLE_QUEUE`, the only VRF oracle queue `lock_army` asks, from `HZ_VALIDATOR` and
// `HZ_VRF_QUEUE` at build time (see build.rs). Changing either takes a new build and an upgrade.
include!(concat!(env!("OUT_DIR"), "/keys.rs"));

/// How long a battle waits for its VRF seed before `cancel_match` may end it, in seconds.
pub const CANCEL_AFTER_SECS: i64 = 600;

#[cfg(feature = "inline-mock-vrf")]
fn program_identity_bump() -> u8 {
    Pubkey::find_program_address(&[b"identity"], &ID).1
}

// `#[ephemeral]` adds `process_undelegation`, which the delegation program calls on Solana to hand
// an undelegated account back to this program. Compiled out under inline-mock-magic: LiteSVM has no
// delegation program.
#[cfg_attr(not(feature = "inline-mock-magic"), ephemeral)]
#[program]
pub mod horizon_zero {
    use super::*;

    /// Only the program's upgrade authority may call it (see `Initialize`), so nobody can front-run
    /// the deployer and become the admin. `set_admin` and `accept_admin` hand the role on later.
    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= fees::MAX_FEE_BPS, HorizonError::FeeTooHigh);
        ctx.accounts.config.admin = ctx.accounts.admin.key();
        ctx.accounts.config.fee_bps = fee_bps;
        ctx.accounts.config.fees = 0;
        ctx.accounts.config.pending_admin = Pubkey::default();
        ctx.accounts.config.bump = ctx.bumps.config;
        let (identity, bump) = Pubkey::find_program_address(&[b"identity"], &ID);
        require_keys_eq!(identity, ctx.accounts.identity.key(), HorizonError::BadPda);
        create_identity(&ctx.accounts.admin, &ctx.accounts.identity.to_account_info(), &[b"identity", &[bump]])?;
        Ok(())
    }

    /// Rollup, admin only: the fee rate battles opened from now on charge. Open battles keep their
    /// own. Config is a typed account here, so it runs where Config is writable: in the rollup once
    /// Config is delegated (on Solana before that).
    pub fn set_fee(ctx: Context<AdminConfig>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= fees::MAX_FEE_BPS, HorizonError::FeeTooHigh);
        ctx.accounts.config.fee_bps = fee_bps;
        msg!("HZ_FEE {}", fee_bps);
        Ok(())
    }

    /// Rollup, admin only: proposes `new_admin`, who takes over by signing `accept_admin`. The
    /// all-zero key withdraws a proposal. A later proposal replaces an earlier one. Runs where
    /// Config is writable, like `set_fee`.
    pub fn set_admin(ctx: Context<AdminConfig>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        msg!("HZ_ADMIN_PROPOSED {}", new_admin);
        Ok(())
    }

    /// Rollup, signed by the proposed admin: makes the signer Config's admin, clears the proposal,
    /// and commits Config so the admin instructions that run on Solana, which read the committed
    /// copy, see the new admin. Signing here proves the new key can act in the rollup, which every
    /// admin instruction there needs. Config is delegated by then, so it runs in the rollup only.
    pub fn accept_admin<'info>(ctx: Context<'info, AcceptAdmin<'info>>) -> Result<()> {
        let info = ctx.accounts.config.to_account_info();
        require_keys_eq!(*info.owner, ID, HorizonError::BadPda);
        let mut config = read_config(&info)?;
        let signer = ctx.accounts.new_admin.key();
        require_keys_eq!(config.pending_admin, signer, HorizonError::NotPendingAdmin);
        // A Config from a build that stored the validator at this offset reads it as a proposal
        // after an in-place upgrade. The rollup validator never becomes admin.
        require_keys_neq!(signer, VALIDATOR, HorizonError::NotPendingAdmin);
        config.admin = signer;
        config.pending_admin = Pubkey::default();
        // By hand, before the commit is scheduled: the rollup refuses writes after it.
        config.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
        msg!("HZ_ADMIN {}", signer);
        schedule_commit(&ctx.accounts.new_admin.to_account_info(), &info, &ctx.accounts.magic)
    }

    pub fn create_battleground(
        ctx: Context<CreateBattleground>,
        battleground_id: u8,
        budget: u16,
        stake_lamports: u64,
        cols: u8,
        rows: u8,
    ) -> Result<()> {
        require_admin(&ctx.accounts.config, &ctx.accounts.admin.key())?;
        let board = Geometry { cols: cols as i32, rows: rows as i32 };
        require!(board.playable(), HorizonError::BadGrid);
        let ground = &mut ctx.accounts.battleground;
        ground.admin = ctx.accounts.admin.key();
        ground.battleground_id = battleground_id;
        ground.budget = budget;
        ground.stake_lamports = stake_lamports;
        ground.cols = cols;
        ground.rows = rows;
        ground.zone_depth = ZONE_DEPTH as u8;
        ground.queue_len = 0;
        ground.queue = [Pubkey::default(); MAX_QUEUE];
        ground.match_seq = 0;
        ground.bump = ctx.bumps.battleground;
        msg!("HZ_BATTLEGROUND {} {} {} {} {} {}", ground.key(), battleground_id, budget, stake_lamports, cols, rows);
        Ok(())
    }

    /// Creates the wallet's Player and Outbox on Solana and moves `deposit` into the Player, where
    /// it is free lamports.
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

    /// Moves `amount` of the Player's free lamports into its budget. No lamports move.
    pub fn fund_budget(ctx: Context<OwnPlayer>, amount: u64) -> Result<()> {
        require!(amount <= free_lamports(&ctx.accounts.player)?, HorizonError::BalanceShort);
        let player = &mut ctx.accounts.player;
        player.budget = player.budget.checked_add(amount).ok_or(HorizonError::BalanceShort)?;
        log_player(&player.key(), player);
        Ok(())
    }

    /// On, payouts go to the winnings and are never staked again. Off, they refill the budget.
    /// Switching does not move what either balance already holds.
    pub fn set_segregation(ctx: Context<OwnPlayer>, segregate: bool) -> Result<()> {
        ctx.accounts.player.segregate = segregate;
        log_player(&ctx.accounts.player.key(), &ctx.accounts.player);
        Ok(())
    }

    /// Creates the ephemeral behavior account for `body`, its rent paid by the creator's Player.
    pub fn create_behavior(ctx: Context<CreateBehavior>, hash: [u8; 32], body: Vec<u8>) -> Result<()> {
        require!(BehaviorBody::parse(&body).is_some(), HorizonError::InvalidBehavior);
        require!(behavior_hash(&body) == hash, HorizonError::HashMismatch);
        let info = ctx.accounts.behavior.to_account_info();
        let (key, bump) = Pubkey::find_program_address(&[b"behavior", &hash], &ID);
        require_keys_eq!(key, info.key(), HorizonError::BadPda);
        require!(info.data_is_empty(), HorizonError::AlreadyExists);
        create_sponsored(
            &ctx.accounts.player,
            &info,
            &[b"behavior", &hash, &[bump]],
            &ctx.accounts.ephemeral.vault,
            8 + Behavior::INIT_SPACE,
        )?;
        let mut stored = [0u8; MAX_BEHAVIOR_LEN];
        stored[..body.len()].copy_from_slice(&body);
        let behavior = Behavior { creator: ctx.accounts.creator.key(), len: body.len() as u8, body: stored, bump };
        eph::write(&info, &behavior)?;
        msg!("HZ_BEHAVIOR {} {} {}", key, behavior.creator, behavior.len);
        Ok(())
    }

    /// Creates the ephemeral army account, its rent paid by the owner's Player.
    pub fn create_army(ctx: Context<CreateArmy>, index: u32, race: u8, units: Vec<UnitInput>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        let info = ctx.accounts.army.to_account_info();
        let index_bytes = index.to_le_bytes();
        let (key, bump) = Pubkey::find_program_address(&[b"army", owner.as_ref(), &index_bytes], &ID);
        require_keys_eq!(key, info.key(), HorizonError::BadPda);
        require!(info.data_is_empty(), HorizonError::AlreadyExists);
        let stored = load_units(
            race,
            &units,
            ctx.remaining_accounts,
            ctx.accounts.battleground.budget,
            ctx.accounts.battleground.cols,
        )?;
        create_sponsored(
            &ctx.accounts.player,
            &info,
            &[b"army", owner.as_ref(), &index_bytes, &[bump]],
            &ctx.accounts.ephemeral.vault,
            8 + Army::INIT_SPACE,
        )?;
        let mut army = Box::new(Army {
            owner,
            battleground: ctx.accounts.battleground.key(),
            race,
            index,
            unit_count: stored.len() as u8,
            units: [ArmyUnit::default(); MAX_UNITS],
            status: ArmyStatus::Idle,
            bump,
        });
        army.units[..stored.len()].copy_from_slice(&stored);
        eph::write(&info, army.as_ref())?;
        msg!("HZ_ARMY {} {} {}", key, army.owner, army.battleground);
        Ok(())
    }

    pub fn update_army(ctx: Context<UpdateArmy>, race: u8, units: Vec<UnitInput>) -> Result<()> {
        require!(ctx.accounts.army.status == ArmyStatus::Idle, HorizonError::BadStatus);
        let stored = load_units(
            race,
            &units,
            ctx.remaining_accounts,
            ctx.accounts.battleground.budget,
            ctx.accounts.battleground.cols,
        )?;
        let army = &mut ctx.accounts.army;
        army.race = race;
        army.unit_count = stored.len() as u8;
        army.units = [ArmyUnit::default(); MAX_UNITS];
        army.units[..stored.len()].copy_from_slice(&stored);
        msg!("HZ_ARMY_UPDATE {}", army.key());
        Ok(())
    }

    /// Deletes an idle army and refunds its rent to the owner's Player. A queued army must unlock
    /// first; past battles keep their own unit snapshots.
    pub fn close_army(ctx: Context<CloseArmy>) -> Result<()> {
        let info = ctx.accounts.army.to_account_info();
        require_keys_eq!(*info.owner, ID, HorizonError::BadPda);
        let army = Box::new(Army::try_deserialize(&mut &info.try_borrow_data()?[..])?);
        let owner = ctx.accounts.owner.key();
        require!(army.owner == owner, HorizonError::NotOwner);
        require!(army.status == ArmyStatus::Idle, HorizonError::BadStatus);
        verify_pda(&[b"army", owner.as_ref(), &army.index.to_le_bytes()], &info.key(), army.bump)?;
        let player = &ctx.accounts.player;
        eph::close(
            &player.to_account_info(),
            &[b"player", owner.as_ref(), &[player.bump]],
            &info,
            &ctx.accounts.ephemeral.vault,
        )?;
        msg!("HZ_ARMY_CLOSE {}", info.key());
        Ok(())
    }

    pub fn lock_army<'info>(ctx: Context<'info, LockArmy<'info>>) -> Result<()> {
        let player = ctx.accounts.player.key();
        require!(ctx.accounts.army.owner == player, HorizonError::NotOwner);
        require!(ctx.accounts.army.battleground == ctx.accounts.battleground.key(), HorizonError::WrongBattleground);
        require!(ctx.accounts.army.status == ArmyStatus::Idle, HorizonError::BadStatus);
        verify_pda(
            &[b"battleground", &[ctx.accounts.battleground.battleground_id]],
            &ctx.accounts.battleground.key(),
            ctx.accounts.battleground.bump,
        )?;
        verify_pda(
            &[b"army", player.as_ref(), &ctx.accounts.army.index.to_le_bytes()],
            &ctx.accounts.army.key(),
            ctx.accounts.army.bump,
        )?;
        // Any VRF-owned queue would take the request; only the pinned one's oracles answer it here.
        require_keys_eq!(ctx.accounts.oracle_queue.key(), ORACLE_QUEUE, HorizonError::BadQueue);
        require!(ctx.accounts.oracle_queue.owner == &VRF_PROGRAM_ID, HorizonError::BadQueue);

        let stake = ctx.accounts.battleground.stake_lamports;
        require!(ctx.accounts.player_account.budget >= stake, HorizonError::BudgetTooLow);
        let QueueScan { found: candidates, evict: evicted } =
            queued_opponents(&ctx.accounts.battleground, player, stake, ctx.remaining_accounts)?;
        for key in &evicted {
            evict(&mut ctx.accounts.battleground, ctx.remaining_accounts, key)?;
        }
        if candidates.is_empty() {
            let army_key = ctx.accounts.army.key();
            ctx.accounts.battleground.enqueue(army_key)?;
            ctx.accounts.army.status = ArmyStatus::Queued;
            msg!("HZ_QUEUED {} {}", army_key, ctx.accounts.battleground.key());
            return Ok(());
        }

        open_matched(ctx, player, stake, candidates)
    }

    pub fn unlock_army(ctx: Context<UnlockArmy>) -> Result<()> {
        let player = ctx.accounts.player.key();
        require!(ctx.accounts.army.owner == player, HorizonError::NotOwner);
        require!(ctx.accounts.army.status == ArmyStatus::Queued, HorizonError::BadStatus);
        require!(ctx.accounts.battleground.queue_contains(&ctx.accounts.army.key()), HorizonError::BadStatus);
        let army_key = ctx.accounts.army.key();
        ctx.accounts.battleground.remove(&army_key);
        ctx.accounts.army.status = ArmyStatus::Idle;
        msg!("HZ_UNLOCK {}", army_key);
        Ok(())
    }

    /// The VRF callback. Stores the seed; anyone may then settle the battle. A whole battle does
    /// not fit in the compute the oracle gives its callback.
    pub fn seed_match(ctx: Context<SeedMatch>, randomness: [u8; 32]) -> Result<()> {
        let battle_key = ctx.accounts.battle.key();
        let battle = &mut ctx.accounts.battle;
        require!(battle.status == BattleStatus::Awaiting, HorizonError::AlreadyResolved);
        battle_seeds(&battle.battleground, battle.seq, battle.bump, &battle_key)?;
        battle.seed = randomness;
        battle.status = BattleStatus::Seeded;
        msg!("HZ_MATCH_SEEDED {} {}", battle_key, hex32(&randomness));
        Ok(())
    }

    /// Plays the battle on the stored seed, pays out and closes the battle. Anyone may call it once
    /// the battle is seeded. The loser's Player pays the winner's Player and the protocol fee; a
    /// draw only releases both stakes back into the budgets.
    pub fn settle_match(ctx: Context<SettleMatch>) -> Result<()> {
        #[cfg(feature = "cu-profile")]
        let entered = remaining_units();
        let info = ctx.accounts.battle.to_account_info();
        let battle_key = info.key();
        // A settled battle is closed, so a second settlement finds no battle.
        require!(!info.data_is_empty(), HorizonError::AlreadyResolved);
        require_keys_eq!(*info.owner, ID, HorizonError::BadPda);
        let battle = read_battle(&info.try_borrow_data()?)?;
        let (head, tail) = (&battle.head, &battle.tail);
        require!(tail.status != BattleStatus::Awaiting, HorizonError::NotSeeded);
        require!(tail.status == BattleStatus::Seeded, HorizonError::AlreadyResolved);
        let accounts = &ctx.accounts;
        check_parties(
            head,
            tail.bump,
            &battle_key,
            &accounts.army_a,
            &accounts.army_b,
            &accounts.player_a,
            &accounts.player_b,
        )?;

        let side_a = combat_units(&battle.units_a, head.count_a)?;
        let side_b = combat_units(&battle.units_b, head.count_b)?;
        // The trace is replayed off-chain; the program only needs the winner.
        #[cfg(feature = "cu-profile")]
        let before = remaining_units();
        let winner =
            simulate_winner(&side_a, &side_b, tail.seed, Geometry { cols: head.cols as i32, rows: head.rows as i32 });
        #[cfg(feature = "cu-profile")]
        log_program_overhead(entered - before);

        // The locker (player B) sponsored the battle; closing refunds its rent. Close before the
        // payout: in the rollup the close is a CPI, and the runtime checks at a CPI that lamports
        // moved only between the accounts it is given.
        let sponsor = ctx.accounts.player_b.to_account_info();
        let sponsor_bump = [ctx.accounts.player_b.bump];
        eph::close(
            &sponsor,
            &[b"player", head.player_b.as_ref(), &sponsor_bump],
            &info,
            &ctx.accounts.ephemeral.vault,
        )?;

        let stake = head.stake;
        let (outcome, fee) = match winner {
            Some(side) => {
                let payout = fees::win_payout(stake, tail.fee_bps);
                let (winner, loser) = match side {
                    Side::A => (&mut ctx.accounts.player_a, &mut ctx.accounts.player_b),
                    Side::B => (&mut ctx.accounts.player_b, &mut ctx.accounts.player_a),
                };
                move_lamports(&loser.to_account_info(), &winner.to_account_info(), payout.to_winner)?;
                move_lamports(&loser.to_account_info(), &ctx.accounts.config.to_account_info(), payout.fee)?;
                winner.credit(payout.credit)?;
                (if side == Side::A { Outcome::A } else { Outcome::B }, payout.fee)
            }
            None => {
                for player in [&mut ctx.accounts.player_a, &mut ctx.accounts.player_b] {
                    player.budget = player.budget.checked_add(stake).ok_or(HorizonError::BalanceShort)?;
                }
                (Outcome::Draw, 0)
            }
        };
        let config = &mut ctx.accounts.config;
        config.fees = config.fees.checked_add(fee).ok_or(HorizonError::BalanceShort)?;
        for player in [&mut ctx.accounts.player_a, &mut ctx.accounts.player_b] {
            player.locked = player.locked.checked_sub(stake).ok_or(HorizonError::NoStake)?;
            player.fighting = player.fighting.checked_sub(1).ok_or(HorizonError::NoStake)?;
            log_player(&player.key(), player);
        }
        ctx.accounts.army_a.status = ArmyStatus::Idle;
        ctx.accounts.army_b.status = ArmyStatus::Idle;
        msg!("HZ_MATCH_RESOLVED {} {} {} {} {}", battle_key, outcome as u8, fee, hex32(&tail.seed), head.player_b);
        Ok(())
    }

    /// Permissionless: ends a battle whose VRF seed never arrived. Allowed only while the battle is
    /// still Awaiting and at least `CANCEL_AFTER_SECS` after `lock_army` opened it. Both stakes go
    /// back to their budgets, both armies become Idle, and the battle's rent goes back to the
    /// locker's Player, which sponsored it.
    ///
    /// A seeded battle cannot be cancelled. Its outcome is fixed by the stored seed, and anyone can
    /// replay it off-chain before settling: a loser who could cancel would cancel every lost battle.
    /// Anyone may settle a seeded battle instead. A VRF callback that arrives after the cancel finds
    /// no battle and fails without effect.
    pub fn cancel_match(ctx: Context<CancelMatch>) -> Result<()> {
        let info = ctx.accounts.battle.to_account_info();
        let battle_key = info.key();
        // A cancelled or settled battle is closed.
        require!(!info.data_is_empty(), HorizonError::AlreadyResolved);
        require_keys_eq!(*info.owner, ID, HorizonError::BadPda);
        let battle = read_battle(&info.try_borrow_data()?)?;
        let (head, tail) = (&battle.head, &battle.tail);
        require!(tail.status != BattleStatus::Seeded, HorizonError::AlreadySeeded);
        require!(tail.status == BattleStatus::Awaiting, HorizonError::AlreadyResolved);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= tail.opened_at.saturating_add(CANCEL_AFTER_SECS), HorizonError::TooEarly);
        let accounts = &ctx.accounts;
        check_parties(
            head,
            tail.bump,
            &battle_key,
            &accounts.army_a,
            &accounts.army_b,
            &accounts.player_a,
            &accounts.player_b,
        )?;

        // Close first, as in `settle_match`: in the rollup the close is a CPI.
        let sponsor_bump = [ctx.accounts.player_b.bump];
        eph::close(
            &ctx.accounts.player_b.to_account_info(),
            &[b"player", head.player_b.as_ref(), &sponsor_bump],
            &info,
            &ctx.accounts.ephemeral.vault,
        )?;
        let stake = head.stake;
        for player in [&mut ctx.accounts.player_a, &mut ctx.accounts.player_b] {
            player.locked = player.locked.checked_sub(stake).ok_or(HorizonError::NoStake)?;
            player.budget = player.budget.checked_add(stake).ok_or(HorizonError::BalanceShort)?;
            player.fighting = player.fighting.checked_sub(1).ok_or(HorizonError::NoStake)?;
            log_player(&player.key(), player);
        }
        ctx.accounts.army_a.status = ArmyStatus::Idle;
        ctx.accounts.army_b.status = ArmyStatus::Idle;
        msg!("HZ_MATCH_CANCELLED {}", battle_key);
        Ok(())
    }

    /// Rollup. Moves `amount` from the owner's Player to their Outbox and records it there. It
    /// takes free lamports first, then winnings, then budget, and never a locked stake. `withdraw`
    /// follows in the same transaction: the rollup refuses a lamport move and the commit of the
    /// account it credits in one instruction.
    pub fn fund_outbox(ctx: Context<FundOutbox>, amount: u64) -> Result<()> {
        let info = ctx.accounts.player.to_account_info();
        let free = free_lamports(&ctx.accounts.player)?;
        let player = &mut ctx.accounts.player;
        let rest = amount.saturating_sub(free);
        let from_winnings = rest.min(player.winnings);
        player.winnings -= from_winnings;
        player.budget = player.budget.checked_sub(rest - from_winnings).ok_or(HorizonError::BalanceShort)?;
        // What the Player must still hold afterwards: its rent and every counter.
        let keep = Rent::get()?
            .minimum_balance(info.data_len())
            .checked_add(player.budget)
            .and_then(|sum| sum.checked_add(player.winnings))
            .and_then(|sum| sum.checked_add(player.locked))
            .ok_or(HorizonError::BalanceShort)?;
        fill_outbox(&info, keep, &mut ctx.accounts.outbox, ctx.accounts.owner.key(), amount)?;
        log_player(&info.key(), &ctx.accounts.player);
        Ok(())
    }

    /// Rollup. In one intent bundle: commits the owner's Player (it stays delegated), and commits
    /// and undelegates the owner's funded Outbox, with a post-undelegate action that calls
    /// `release_outbox` on Solana. The owner signs as the intent's payer; the validator identity pays
    /// the Solana transactions that carry it out. Committing the Player settles the validator's books
    /// (see `schedule_release`).
    pub fn withdraw<'info>(ctx: Context<'info, Withdraw<'info>>) -> Result<()> {
        let outbox = ctx.accounts.outbox.to_account_info();
        let state = read_funded_outbox(&outbox)?;
        require_keys_eq!(state.owner, ctx.accounts.owner.key(), HorizonError::NotOwner);
        let player = ctx.accounts.player.to_account_info();
        require_keys_eq!(*player.owner, ID, HorizonError::BadPda);
        msg!("HZ_WITHDRAW {} {}", outbox.key(), state.amount);
        schedule_release(&ctx.accounts.owner.to_account_info(), &player, &outbox, state.owner, &ctx.accounts.magic)
    }

    /// Solana, admin only: creates the treasury Outbox `[b"outbox", config]`, which pays the admin.
    pub fn init_treasury_outbox(ctx: Context<InitTreasuryOutbox>) -> Result<()> {
        require_admin(&ctx.accounts.config, &ctx.accounts.admin.key())?;
        ctx.accounts.outbox.owner = ctx.accounts.admin.key();
        ctx.accounts.outbox.amount = 0;
        ctx.accounts.outbox.bump = ctx.bumps.outbox;
        Ok(())
    }

    /// Rollup, admin only: moves all claimable fees from Config to the treasury Outbox, payable to
    /// the admin. `claim_fees` follows in the same transaction.
    pub fn fund_treasury_outbox(ctx: Context<FundTreasuryOutbox>) -> Result<()> {
        let info = ctx.accounts.config.to_account_info();
        let fees = ctx.accounts.config.fees;
        ctx.accounts.config.fees = 0;
        // Config keeps its rent; the fees were the rest.
        let keep = Rent::get()?.minimum_balance(info.data_len());
        fill_outbox(&info, keep, &mut ctx.accounts.outbox, ctx.accounts.admin.key(), fees)
    }

    /// Rollup, admin only: as `withdraw`, for the funded treasury Outbox, committing Config.
    pub fn claim_fees<'info>(ctx: Context<'info, ClaimFees<'info>>) -> Result<()> {
        let config = ctx.accounts.config.to_account_info();
        require_admin(&config, &ctx.accounts.admin.key())?;
        require_keys_eq!(*config.owner, ID, HorizonError::BadPda);
        let outbox = ctx.accounts.outbox.to_account_info();
        let mut state = read_funded_outbox(&outbox)?;
        let admin = ctx.accounts.admin.key();
        if state.owner != admin {
            // Funded under the previous admin and not claimed before `accept_admin`: the claim
            // pays the current admin. Written by hand before the undelegation is scheduled.
            state.owner = admin;
            state.try_serialize(&mut &mut outbox.try_borrow_mut_data()?[..])?;
        }
        msg!("HZ_CLAIM {} {}", outbox.key(), state.amount);
        schedule_release(&ctx.accounts.admin.to_account_info(), &config, &outbox, state.owner, &ctx.accounts.magic)
    }

    /// Solana, permissionless: pays an undelegated Outbox's `amount` to its recorded owner and
    /// zeroes it. The post-undelegate action calls it; anyone may call it again, which does nothing.
    /// It only works on Solana: in the rollup the owner wallet is not delegated, so the rollup refuses
    /// the credit, and once `withdraw` has run the Outbox belongs to the delegation program.
    pub fn release_outbox(ctx: Context<ReleaseOutbox>) -> Result<()> {
        let amount = ctx.accounts.outbox.amount;
        if amount == 0 {
            return Ok(());
        }
        ctx.accounts.outbox.amount = 0;
        move_lamports(&ctx.accounts.outbox.to_account_info(), &ctx.accounts.owner.to_account_info(), amount)?;
        msg!("HZ_RELEASE {} {}", ctx.accounts.outbox.key(), amount);
        Ok(())
    }

    /// Solana: delegates the owner's Player to the rollup validator.
    #[cfg(not(feature = "inline-mock-magic"))]
    pub fn delegate_player(ctx: Context<DelegatePlayer>) -> Result<()> {
        require_owned(&ctx.accounts.player)?;
        let owner = ctx.accounts.owner.key();
        ctx.accounts.delegate_player(&ctx.accounts.owner, &[b"player", owner.as_ref()], delegation())?;
        Ok(())
    }

    /// Solana: delegates the owner's Outbox to the rollup validator, before each withdrawal. An Outbox that
    /// still holds an unreleased withdrawal is refused, so the payment is not locked back into the
    /// rollup.
    #[cfg(not(feature = "inline-mock-magic"))]
    pub fn delegate_outbox(ctx: Context<DelegateOutbox>) -> Result<()> {
        require!(read_outbox(&ctx.accounts.outbox)?.amount == 0, HorizonError::OutboxBusy);
        let owner = ctx.accounts.owner.key();
        ctx.accounts.delegate_outbox(&ctx.accounts.owner, &[b"outbox", owner.as_ref()], delegation())?;
        Ok(())
    }

    /// Solana, admin only: delegates Config to the rollup validator.
    #[cfg(not(feature = "inline-mock-magic"))]
    pub fn delegate_config(ctx: Context<DelegateConfig>) -> Result<()> {
        require_admin(&ctx.accounts.config, &ctx.accounts.admin.key())?;
        require_owned(&ctx.accounts.config)?;
        ctx.accounts.delegate_config(&ctx.accounts.admin, &[b"config"], delegation())?;
        Ok(())
    }

    /// Solana, admin only: delegates battleground `battleground_id` to the rollup validator.
    #[cfg(not(feature = "inline-mock-magic"))]
    pub fn delegate_battleground(ctx: Context<DelegateBattleground>, battleground_id: u8) -> Result<()> {
        require_admin(&ctx.accounts.config, &ctx.accounts.admin.key())?;
        require_owned(&ctx.accounts.battleground)?;
        let seeds: &[&[u8]] = &[b"battleground", &[battleground_id]];
        ctx.accounts.delegate_battleground(&ctx.accounts.admin, seeds, delegation())?;
        Ok(())
    }

    /// Solana, admin only: delegates the treasury Outbox to the rollup validator, before each claim. Same
    /// rule as `delegate_outbox`: an unreleased claim is refused.
    #[cfg(not(feature = "inline-mock-magic"))]
    pub fn delegate_treasury_outbox(ctx: Context<DelegateTreasuryOutbox>) -> Result<()> {
        require_admin(&ctx.accounts.config, &ctx.accounts.admin.key())?;
        require!(read_outbox(&ctx.accounts.outbox)?.amount == 0, HorizonError::OutboxBusy);
        let key = ctx.accounts.config.key();
        ctx.accounts.delegate_outbox(&ctx.accounts.admin, &[b"outbox", key.as_ref()], delegation())?;
        Ok(())
    }
}

/// A delegate instruction's account must be this program's: one that does not exist yet would be
/// assigned to the delegation program empty, and one already delegated belongs to it. The seeds
/// constraint's prefix (`player`, `config`, `battleground`) already says which type it is, and only
/// this program creates accounts at those addresses, so no discriminator check is needed.
#[cfg(not(feature = "inline-mock-magic"))]
fn require_owned(info: &AccountInfo) -> Result<()> {
    require_keys_eq!(*info.owner, ID, HorizonError::BadPda);
    Ok(())
}

/// What every delegate instruction asks the delegation program for: the rollup validator built
/// into the program (the SDK's default identity is not the local rollup's), and the SDK's default
/// commit frequency, `u32::MAX` ms, so nothing schedules commits.
#[cfg(not(feature = "inline-mock-magic"))]
fn delegation() -> ephemeral_rollups_sdk::cpi::DelegateConfig {
    ephemeral_rollups_sdk::cpi::DelegateConfig { validator: Some(VALIDATOR), ..Default::default() }
}

/// The shared step of `fund_outbox` and `fund_treasury_outbox`: moves `amount` from `source` to an
/// idle Outbox, which then pays `owner`. `source` must still hold `keep` lamports afterwards.
fn fill_outbox(
    source: &AccountInfo,
    keep: u64,
    outbox: &mut Account<Outbox>,
    owner: Pubkey,
    amount: u64,
) -> Result<()> {
    require!(outbox.amount == 0, HorizonError::OutboxBusy);
    require!(amount > 0, HorizonError::NothingToWithdraw);
    move_lamports(source, &outbox.to_account_info(), amount)?;
    require!(source.lamports() >= keep, HorizonError::BalanceShort);
    outbox.owner = owner;
    outbox.amount = amount;
    msg!("HZ_OUTBOX_FUND {} {} {}", outbox.key(), owner, amount);
    Ok(())
}

/// Config read by hand, for the instructions that run on Solana. Once Config is delegated, its
/// Solana copy is owned by the delegation program, and a typed `Account<Config>` would refuse it;
/// the data stays the same. The owner must be this program or the delegation program, and the
/// address the `[b"config"]` PDA.
/// It trusts the last committed Config, which is sound only for the one field Solana reads, `admin`:
/// `accept_admin`, the only instruction that changes it, commits Config in the same transaction.
fn read_config(info: &AccountInfo) -> Result<Config> {
    require!(*info.owner == ID || *info.owner == DELEGATION_PROGRAM, HorizonError::BadPda);
    let config = Config::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    verify_pda(&[b"config"], &info.key(), config.bump)?;
    Ok(config)
}

/// [`read_config`], and `signer` must be its admin.
fn require_admin(info: &AccountInfo, signer: &Pubkey) -> Result<Config> {
    let config = read_config(info)?;
    require_keys_eq!(config.admin, *signer, HorizonError::NotAdmin);
    Ok(config)
}

/// An Outbox read by hand: it must be owned by this program and carry the Outbox discriminator.
fn read_outbox(info: &AccountInfo) -> Result<Outbox> {
    require_keys_eq!(*info.owner, ID, HorizonError::BadPda);
    Outbox::try_deserialize(&mut &info.try_borrow_data()?[..])
}

/// An Outbox read by hand, for the instructions that schedule its undelegation: a typed account
/// would be written back after the scheduling CPI, when the rollup no longer lets the program
/// change it. It must hold a recorded amount.
fn read_funded_outbox(info: &AccountInfo) -> Result<Outbox> {
    let state = read_outbox(info)?;
    require!(state.amount != 0, HorizonError::NothingToWithdraw);
    Ok(state)
}

/// Schedules, in one intent bundle, a plain commit of `source` (the Player or Config the money
/// left; it stays delegated) and the commit and undelegation of `outbox`, then a `release_outbox`
/// call on Solana that pays `owner`. `payer` signs as the intent's payer; the validator identity
/// sends and pays the Solana transactions (commit, finalize, undelegate, action).
///
/// The commit of `source` is what keeps the validator's books exact. A top-up reaches the Player in
/// the rollup only: on Solana its lamports go from the eSPL lamports PDA, once committed down, to the
/// validator's fees vault. A commit that raises a delegated account's Solana balance is paid by the
/// validator identity. Committing the Outbox alone would have the validator pay out the amount while
/// Solana's Player still showed the money; committing `source` with it moves Solana's copy to the
/// rollup's balance, so what the validator pays matches what its fees vault took in for that account.
/// These are the only commits the program schedules: a Player or Config is committed when cash leaves
/// it, never on a timer.
///
/// Both accounts must be unchecked in the calling instruction: once scheduled, the rollup no
/// longer lets the program write them, so Anchor must not serialize a typed copy afterwards.
/// Under `inline-mock-magic` it does nothing: nothing is delegated there, and the tests call
/// `release_outbox` themselves.
fn schedule_release<'info>(
    payer: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    outbox: &AccountInfo<'info>,
    owner: Pubkey,
    magic: &MagicAccounts<'info>,
) -> Result<()> {
    #[cfg(feature = "inline-mock-magic")]
    {
        let _ = (payer, source, outbox, owner, magic);
    }
    #[cfg(not(feature = "inline-mock-magic"))]
    {
        use ephemeral_rollups_sdk::ephem::{CallHandler, FoldableIntentBuilder, MagicIntentBundleBuilder};
        use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};
        let release = CallHandler {
            destination_program: ID,
            accounts: vec![
                ShortAccountMeta { pubkey: outbox.key(), is_writable: true },
                ShortAccountMeta { pubkey: owner, is_writable: true },
            ],
            args: ActionArgs::new(instruction::ReleaseOutbox::DISCRIMINATOR.to_vec()),
            escrow_authority: payer.clone(),
            compute_units: 20_000,
        };
        MagicIntentBundleBuilder::new(
            payer.clone(),
            magic.magic_context.to_account_info(),
            magic.magic_program.to_account_info(),
        )
        .commit(std::slice::from_ref(source))
        .commit_and_undelegate(std::slice::from_ref(outbox))
        .add_post_undelegate_actions([release])
        .build_and_invoke()?;
    }
    Ok(())
}

/// Schedules a plain commit of `config` (it stays delegated), paid by `payer`, so Solana's copy
/// carries the admin `accept_admin` just wrote. Under `inline-mock-magic` it does nothing: nothing
/// is delegated there.
fn schedule_commit<'info>(
    payer: &AccountInfo<'info>,
    config: &AccountInfo<'info>,
    magic: &MagicAccounts<'info>,
) -> Result<()> {
    #[cfg(feature = "inline-mock-magic")]
    {
        let _ = (payer, config, magic);
    }
    #[cfg(not(feature = "inline-mock-magic"))]
    {
        use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};
        MagicIntentBundleBuilder::new(
            payer.clone(),
            magic.magic_context.to_account_info(),
            magic.magic_program.to_account_info(),
        )
        .commit(std::slice::from_ref(config))
        .build_and_invoke()?;
    }
    Ok(())
}

/// What `settle_match` reads from a battle, with the filled snapshot slots on the heap: a whole
/// `Battle` value and its copy do not fit the 4 KB SBF stack frame.
struct SettledBattle {
    head: BattleFront,
    units_a: Vec<SnapshotUnit>,
    units_b: Vec<SnapshotUnit>,
    tail: BattleBack,
}

/// `Battle`'s fields before the snapshots, in declaration order.
#[derive(AnchorDeserialize)]
struct BattleFront {
    battleground: Pubkey,
    army_a: Pubkey,
    army_b: Pubkey,
    player_a: Pubkey,
    player_b: Pubkey,
    stake: u64,
    seq: u64,
    count_a: u8,
    count_b: u8,
    cols: u8,
    rows: u8,
}

/// `Battle`'s fields after the snapshots, in declaration order.
#[derive(AnchorDeserialize)]
struct BattleBack {
    status: BattleStatus,
    seed: [u8; 32],
    _outcome: Outcome,
    _race_a: u8,
    _race_b: u8,
    fee_bps: u16,
    opened_at: i64,
    bump: u8,
}

fn read_battle(data: &[u8]) -> Result<SettledBattle> {
    require!(data.starts_with(Battle::DISCRIMINATOR), anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch);
    let mut cursor = &data[Battle::DISCRIMINATOR.len()..];
    let head = BattleFront::deserialize(&mut cursor)?;
    // Only the `count` filled slots, sized up front: the SBF heap is a bump allocator, so a
    // growing vector leaks each old buffer, and the simulation needs most of the 32 KB.
    let side = |cursor: &mut &[u8], count: u8| -> Result<Vec<SnapshotUnit>> {
        let mut units = Vec::with_capacity(count as usize);
        for slot in 0..MAX_UNITS {
            let unit = SnapshotUnit::deserialize(cursor)?;
            if slot < count as usize {
                units.push(unit);
            }
        }
        Ok(units)
    };
    let units_a = side(&mut cursor, head.count_a)?;
    let units_b = side(&mut cursor, head.count_b)?;
    let tail = BattleBack::deserialize(&mut cursor)?;
    Ok(SettledBattle { head, units_a, units_b, tail })
}

/// The Player's lamports above its rent that no counter claims.
fn free_lamports(player: &Account<Player>) -> Result<u64> {
    let info = player.to_account_info();
    player.free(info.lamports(), Rent::get()?.minimum_balance(info.data_len()))
}

/// Creates an ephemeral account sponsored by `player`, after checking its free lamports cover the
/// rent so a stake or a payout is never spent on storage.
fn create_sponsored<'info>(
    player: &Account<'info, Player>,
    account: &AccountInfo<'info>,
    account_seeds: &[&[u8]],
    vault: &AccountInfo<'info>,
    space: usize,
) -> Result<()> {
    require!(free_lamports(player)? >= eph::rent(space)?, HorizonError::RentShort);
    let info = player.to_account_info();
    let bump = [player.bump];
    eph::create(&info, &[b"player", player.owner.as_ref(), &bump], account, account_seeds, vault, space)
}

/// What `settle_match` and `cancel_match` check before they touch a battle's parties: the battle's
/// address, each army is the battle's and Fighting, and each Player is the battle's wallet's.
fn check_parties(
    head: &BattleFront,
    bump: u8,
    key: &Pubkey,
    army_a: &Account<Army>,
    army_b: &Account<Army>,
    player_a: &Account<Player>,
    player_b: &Account<Player>,
) -> Result<()> {
    battle_seeds(&head.battleground, head.seq, bump, key)?;
    require_keys_eq!(army_a.key(), head.army_a, HorizonError::BadPda);
    require_keys_eq!(army_b.key(), head.army_b, HorizonError::BadPda);
    verify_pda(&[b"player", head.player_a.as_ref()], &player_a.key(), player_a.bump)?;
    verify_pda(&[b"player", head.player_b.as_ref()], &player_b.key(), player_b.bump)?;
    require!(army_a.status == ArmyStatus::Fighting, HorizonError::BadStatus);
    require!(army_b.status == ArmyStatus::Fighting, HorizonError::BadStatus);
    Ok(())
}

/// Checks the battle address against its stored canonical bump (lock_army created it with that
/// bump), one derivation instead of a bump search.
fn battle_seeds(battleground: &Pubkey, seq: u64, bump: u8, key: &Pubkey) -> Result<()> {
    let derived = Pubkey::create_program_address(&[b"match", battleground.as_ref(), &seq.to_le_bytes(), &[bump]], &ID)
        .map_err(|_| HorizonError::BadPda)?;
    require_keys_eq!(derived, *key, HorizonError::BadPda);
    Ok(())
}

#[inline(never)]
fn open_matched<'info>(
    ctx: Context<'info, LockArmy<'info>>,
    player: Pubkey,
    stake: u64,
    candidates: Vec<(Pubkey, usize)>,
) -> Result<()> {
    // The candidates are the queue's front window, not the locker's choice. The pick reads the
    // most recent slot hash at execution, which the locker sees only after it has sent the lock.
    let hash = recent_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
    let pick = (u64::from_le_bytes(hash[..8].try_into().unwrap()) as usize) % candidates.len();
    let (opponent_key, opponent_player_at) = candidates[pick];
    let opponent = account_by_key(ctx.remaining_accounts, &opponent_key)?;
    let opponent_player = ctx.remaining_accounts[opponent_player_at].clone();
    let mut opponent_state = Player::try_deserialize(&mut &opponent_player.try_borrow_data()?[..])?;
    let mut opponent_army = Box::new(Army::try_deserialize(&mut &opponent.try_borrow_data()?[..])?);
    let opponent_owner = opponent_army.owner;
    require!(opponent_army.status == ArmyStatus::Queued, HorizonError::BadStatus);
    require!(opponent_army.owner != player, HorizonError::OwnArmy);

    let ground = ctx.accounts.battleground.key();
    let seq = ctx.accounts.battleground.match_seq;
    let seq_bytes = seq.to_le_bytes();
    let (battle_key, battle_bump) = Pubkey::find_program_address(&[b"match", ground.as_ref(), &seq_bytes], &ID);
    require_keys_eq!(battle_key, ctx.accounts.battle.key(), HorizonError::BadMatch);
    // The locker's Player sponsors the battle; `settle_match` closes it and refunds the rent.
    create_sponsored(
        &ctx.accounts.player_account,
        &ctx.accounts.battle.to_account_info(),
        &[b"match", ground.as_ref(), &seq_bytes, &[battle_bump]],
        &ctx.accounts.ephemeral.vault,
        8 + Battle::INIT_SPACE,
    )?;

    {
        let mut data = ctx.accounts.battle.try_borrow_mut_data()?;
        let head = BattleHead {
            battleground: ground,
            army_a: opponent_key,
            army_b: ctx.accounts.army.key(),
            player_a: opponent_owner,
            player_b: player,
            stake,
            seq,
            cols: ctx.accounts.battleground.cols,
            rows: ctx.accounts.battleground.rows,
            fee_bps: ctx.accounts.config.fee_bps,
            opened_at: Clock::get()?.unix_timestamp,
            bump: battle_bump,
        };
        write_battle(&mut data, &head, &opponent_army, &ctx.accounts.army)?;
    }

    ctx.accounts.battleground.remove(&opponent_key);
    ctx.accounts.battleground.match_seq = seq.checked_add(1).unwrap();
    ctx.accounts.army.status = ArmyStatus::Fighting;
    {
        let mut data = opponent.try_borrow_mut_data()?;
        opponent_army.status = ArmyStatus::Fighting;
        opponent_army.try_serialize(&mut data.as_mut())?;
    }
    // Stakes stay on the Players until settlement; only the counters move.
    for account in [&mut **ctx.accounts.player_account, &mut opponent_state] {
        account.budget = account.budget.checked_sub(stake).ok_or(HorizonError::BudgetTooLow)?;
        account.locked = account.locked.checked_add(stake).ok_or(HorizonError::BalanceShort)?;
        account.fighting = account.fighting.checked_add(1).ok_or(HorizonError::PlayerBusy)?;
    }
    opponent_state.try_serialize(&mut opponent_player.try_borrow_mut_data()?.as_mut())?;
    ctx.accounts.army.exit(&ID)?;
    ctx.accounts.battleground.exit(&ID)?;
    ctx.accounts.player_account.exit(&ID)?;

    request_vrf(&ctx)?;
    log_player(&ctx.accounts.player_account.key(), &ctx.accounts.player_account);
    log_player(opponent_player.key, &opponent_state);
    msg!("HZ_MATCH_OPEN {} {} {} {}", battle_key, opponent_key, ctx.accounts.army.key(), stake);
    Ok(())
}

fn request_vrf<'info>(ctx: &Context<'info, LockArmy<'info>>) -> Result<()> {
    let battle = ctx.accounts.battle.key();
    let seed = horizon_combat::sha256(&[battle.as_ref()]);
    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.player.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: ID,
        callback_discriminator: instruction::SeedMatch::DISCRIMINATOR.to_vec(),
        caller_seed: seed,
        accounts_metas: Some(vec![meta(battle, true)]),
        ..Default::default()
    });

    #[cfg(feature = "inline-mock-vrf")]
    {
        // The mock VRF accepts the request without reading it; LiteSVM fulfills it separately.
        let infos = [
            ctx.accounts.player.to_account_info(),
            ctx.accounts.program_identity.to_account_info(),
            ctx.accounts.oracle_queue.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.slot_hashes.to_account_info(),
        ];
        anchor_lang::solana_program::program::invoke_signed(&ix, &infos, &[&[b"identity", &[program_identity_bump()]]])
            .map_err(|_| error!(HorizonError::VrfRequest))?;
    }
    #[cfg(not(feature = "inline-mock-vrf"))]
    {
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.player.to_account_info(), &ix)
            .map_err(|_| error!(HorizonError::VrfRequest))?;
    }
    Ok(())
}

fn meta(key: Pubkey, writable: bool) -> SerializableAccountMeta {
    SerializableAccountMeta { pubkey: key, is_signer: false, is_writable: writable }
}

fn load_units(race: u8, units: &[UnitInput], accounts: &[AccountInfo], budget: u16, cols: u8) -> Result<Vec<ArmyUnit>> {
    require!(horizon_combat::race_known(race), HorizonError::BadRace);
    require!(units.len() <= MAX_UNITS && !units.is_empty(), HorizonError::TooManyUnits);
    let mut stored = Vec::with_capacity(units.len());
    for (index, unit) in units.iter().enumerate() {
        let stats = horizon_combat::stats_for(race, unit.kind).ok_or(HorizonError::BadUnit)?;
        require!(unit.col < cols && unit.row < ZONE_DEPTH as u8, HorizonError::BadPosition);
        let account = accounts.get(index).ok_or(HorizonError::MissingBehavior)?;
        require_keys_eq!(*account.key, unit.behavior, HorizonError::MissingBehavior);
        let behavior = Behavior::try_deserialize(&mut &account.try_borrow_data()?[..])?;
        let bytes = behavior_bytes(&behavior)?;
        let hash = behavior_hash(bytes);
        let (pda, _) = Pubkey::find_program_address(&[b"behavior", &hash], &ID);
        require_keys_eq!(pda, unit.behavior, HorizonError::HashMismatch);
        let mut body = [0u8; MAX_BEHAVIOR_LEN];
        body[..bytes.len()].copy_from_slice(bytes);
        stored.push(ArmyUnit {
            kind: unit.kind,
            behavior: unit.behavior,
            len: bytes.len() as u8,
            body,
            col: unit.col,
            row: unit.row,
            cost: stats.cost,
            hp: stats.hp as u8,
            atk: stats.atk as u8,
            range: stats.range as u8,
            speed: stats.speed as u8,
            cast: crate::state::CastParams {
                damage: stats.cast.damage,
                range: stats.cast.range,
                aoe: stats.cast.aoe,
                effect: stats.cast.effect.id(),
                aim: stats.cast.aim.id(),
                power: stats.cast.power,
                rounds: stats.cast.rounds,
                cooldown: stats.cast.cooldown,
            },
            actions: stats.actions as u8,
        });
    }
    for (index, unit) in stored.iter().enumerate() {
        let shared = stored.iter().take(index).any(|other| other.col == unit.col && other.row == unit.row);
        require!(!shared, HorizonError::DuplicatePosition);
    }
    let mut cost: u16 = 0;
    for unit in &stored {
        cost = cost.checked_add(unit.cost).ok_or(HorizonError::BadUnit)?;
    }
    if cost > budget {
        return Err(HorizonError::BudgetExceeded.into());
    }
    Ok(stored)
}

/// How many queue entries, from the front, a lock must pass and may meet. Eight armies and eight
/// distinct owners' Players are what a legacy transaction holds next to `lock_army`'s own accounts.
pub const MATCH_WINDOW: usize = 8;

/// What `queued_opponents` found in the battleground queue.
struct QueueScan {
    /// Armies a locker may meet, each with the index of its owner's Player in the accounts.
    found: Vec<(Pubkey, usize)>,
    /// Armies whose owner's Player was passed and no longer covers the stake.
    evict: Vec<Pubkey>,
}

/// The queued armies a locker may meet, each with the index of its owner's Player in `accounts`,
/// and the queued armies to evict: their owner's Player no longer covers the stake. The program,
/// not the locker, sets the candidates: the first [`MATCH_WINDOW`] queue entries. Each of them must
/// be passed, with its owner's Player unless the locker owns it (`MissingAccount`), so a locker
/// cannot leave out the armies it would rather not meet.
fn queued_opponents(
    ground: &Account<Battleground>,
    player: Pubkey,
    stake: u64,
    accounts: &[AccountInfo],
) -> Result<QueueScan> {
    // (owner, index, budget) of each authentic Player passed: program-owned, Player-sized, a
    // `Player`, and at `[b"player", owner]` with its stored bump.
    let mut players = Vec::new();
    for (at, account) in accounts.iter().enumerate() {
        if account.owner == &ID && account.data_len() == 8 + Player::INIT_SPACE {
            if let Ok(state) = Player::try_deserialize(&mut &account.try_borrow_data()?[..]) {
                if verify_pda(&[b"player", state.owner.as_ref()], account.key, state.bump).is_ok() {
                    players.push((state.owner, at, state.budget));
                }
            }
        }
    }
    let (mut found, mut evict) = (Vec::new(), Vec::new());
    for key in ground.queue[..ground.queue_len as usize].iter().take(MATCH_WINDOW) {
        let account = accounts.iter().find(|account| account.key == key).ok_or(HorizonError::MissingAccount)?;
        let army = Army::try_deserialize(&mut &account.try_borrow_data()?[..])?;
        if army.owner == player || army.status != ArmyStatus::Queued {
            continue;
        }
        match players.iter().find(|(owner, _, _)| *owner == army.owner) {
            Some(&(_, at, budget)) if budget >= stake => found.push((*key, at)),
            Some(_) => evict.push(*key),
            None => return err!(HorizonError::MissingAccount),
        }
    }
    Ok(QueueScan { found, evict })
}

/// Takes a queued army out of the queue and sets it Idle: its owner's budget no longer covers a
/// stake, so no locker could meet it, and left there it would hold a queue slot forever.
fn evict(ground: &mut Battleground, accounts: &[AccountInfo], key: &Pubkey) -> Result<()> {
    let account = accounts.iter().find(|account| account.key == key).ok_or(HorizonError::MissingAccount)?;
    let mut army = Box::new(Army::try_deserialize(&mut &account.try_borrow_data()?[..])?);
    army.status = ArmyStatus::Idle;
    army.try_serialize(&mut account.try_borrow_mut_data()?.as_mut())?;
    ground.remove(key);
    msg!("HZ_EVICT {}", key);
    Ok(())
}

/// The fields of a new battle that do not come from the two armies.
struct BattleHead {
    battleground: Pubkey,
    army_a: Pubkey,
    army_b: Pubkey,
    player_a: Pubkey,
    player_b: Pubkey,
    stake: u64,
    seq: u64,
    cols: u8,
    rows: u8,
    fee_bps: u16,
    opened_at: i64,
    bump: u8,
}

/// Serializes a new `Battle` straight into its account, field by field in declaration order.
/// Building the `Battle` value first would put both snapshot arrays on the 4 KB SBF stack.
#[inline(never)]
fn write_battle(data: &mut [u8], head: &BattleHead, army_a: &Army, army_b: &Army) -> Result<()> {
    let mut out = data;
    std::io::Write::write_all(&mut out, Battle::DISCRIMINATOR)?;
    head.battleground.serialize(&mut out)?;
    head.army_a.serialize(&mut out)?;
    head.army_b.serialize(&mut out)?;
    head.player_a.serialize(&mut out)?;
    head.player_b.serialize(&mut out)?;
    head.stake.serialize(&mut out)?;
    head.seq.serialize(&mut out)?;
    army_a.unit_count.serialize(&mut out)?;
    army_b.unit_count.serialize(&mut out)?;
    head.cols.serialize(&mut out)?;
    head.rows.serialize(&mut out)?;
    write_snapshot(&mut out, army_a)?;
    write_snapshot(&mut out, army_b)?;
    BattleStatus::Awaiting.serialize(&mut out)?;
    [0u8; 32].serialize(&mut out)?;
    Outcome::Pending.serialize(&mut out)?;
    army_a.race.serialize(&mut out)?;
    army_b.race.serialize(&mut out)?;
    head.fee_bps.serialize(&mut out)?;
    head.opened_at.serialize(&mut out)?;
    head.bump.serialize(&mut out)?;
    Ok(())
}

/// One side's `MAX_UNITS` snapshot slots, copied from the army; unused slots are zero.
fn write_snapshot(out: &mut &mut [u8], army: &Army) -> Result<()> {
    for index in 0..MAX_UNITS {
        let unit = if index < army.unit_count as usize {
            let unit = &army.units[index];
            SnapshotUnit {
                kind: unit.kind,
                len: unit.len,
                body: unit.body,
                col: unit.col,
                row: unit.row,
                cost: unit.cost,
                hp: unit.hp,
                atk: unit.atk,
                range: unit.range,
                speed: unit.speed,
                cast: unit.cast,
                actions: unit.actions,
            }
        } else {
            SnapshotUnit::default()
        };
        unit.serialize(out)?;
    }
    Ok(())
}

fn combat_units(units: &[SnapshotUnit], count: u8) -> Result<Vec<CombatUnit>> {
    units
        .iter()
        .take(count as usize)
        .map(|unit| {
            Ok(CombatUnit {
                kind: unit.kind,
                behavior: BehaviorBody::parse(&unit.body[..unit.len as usize]).unwrap_or_default(),
                col: unit.col,
                row: unit.row,
                cost: unit.cost,
                hp: unit.hp as i32,
                atk: unit.atk as i32,
                range: unit.range as i32,
                speed: unit.speed as i32,
                actions: unit.actions as i32,
                cast: horizon_combat::Cast {
                    damage: unit.cast.damage,
                    range: unit.cast.range,
                    aoe: unit.cast.aoe,
                    // The army copied these from the catalog, so they are known ids.
                    effect: Effect::from_u8(unit.cast.effect).ok_or(HorizonError::BadUnit)?,
                    aim: Aim::from_u8(unit.cast.aim).ok_or(HorizonError::BadUnit)?,
                    power: unit.cast.power,
                    rounds: unit.cast.rounds,
                    cooldown: unit.cast.cooldown,
                },
            })
        })
        .collect()
}

fn verify_pda(seeds: &[&[u8]], key: &Pubkey, bump: u8) -> Result<()> {
    let mut with_bump = seeds.to_vec();
    let bump_arr = [bump];
    with_bump.push(&bump_arr);
    let derived = Pubkey::create_program_address(&with_bump, &ID).map_err(|_| error!(HorizonError::BadPda))?;
    require_keys_eq!(derived, *key, HorizonError::BadPda);
    Ok(())
}

fn recent_slot_hash(slot_hashes: &AccountInfo) -> Result<[u8; 32]> {
    let data = slot_hashes.try_borrow_data()?;
    if data.len() >= 48 {
        let len = u64::from_le_bytes(data[0..8].try_into().unwrap());
        if len > 0 {
            let mut hash = [0u8; 32];
            hash.copy_from_slice(&data[16..48]);
            return Ok(hash);
        }
    }
    Ok(Clock::get()?.slot.to_le_bytes().repeat(4).try_into().unwrap())
}

fn account_by_key<'a>(accounts: &'a [AccountInfo<'a>], key: &Pubkey) -> Result<AccountInfo<'a>> {
    accounts.iter().find(|account| account.key == key).cloned().ok_or_else(|| error!(HorizonError::MissingAccount))
}

/// Creates the program identity PDA with space 0, owned by this program. Anyone can send lamports
/// to its address beforehand, which would make a system `create_account` fail, so it tops the
/// account up to rent from `payer` when short, then assigns it signed by its seeds.
fn create_identity<'info>(payer: &Signer<'info>, identity: &AccountInfo<'info>, seeds: &[&[u8]]) -> Result<()> {
    use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
    let rent = Rent::get()?.minimum_balance(0);
    let short = rent.saturating_sub(identity.lamports());
    if short > 0 {
        transfer_sol(payer, identity, short)?;
    }
    // With space 0 there is nothing to allocate; assign fails unless the account is still the
    // system program's with no data, so an identity that already exists is refused.
    invoke_signed(&system_instruction::assign(identity.key, &ID), std::slice::from_ref(identity), &[seeds])?;
    Ok(())
}

fn transfer_sol<'info>(from: &Signer<'info>, to: &AccountInfo<'info>, lamports: u64) -> Result<()> {
    anchor_lang::system_program::transfer(
        CpiContext::new(
            system_program::ID,
            anchor_lang::system_program::Transfer { from: from.to_account_info(), to: to.clone() },
        ),
        lamports,
    )
}

pub(crate) fn move_lamports(from: &AccountInfo, to: &AccountInfo, lamports: u64) -> Result<()> {
    require!(from.lamports() >= lamports, HorizonError::BalanceShort);
    **from.try_borrow_mut_lamports()? -= lamports;
    **to.try_borrow_mut_lamports()? += lamports;
    Ok(())
}

fn log_player(key: &Pubkey, player: &Player) {
    msg!(
        "HZ_PLAYER {} {} {} {} {} {} {}",
        key,
        player.owner,
        player.budget,
        player.winnings,
        player.locked,
        player.segregate as u8,
        player.fighting
    );
}

fn hex32(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UnitInput {
    pub kind: u8,
    pub behavior: Pubkey,
    pub col: u8,
    pub row: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: VRF request signer, created here
    #[account(mut)]
    pub identity: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// This program's account; it must point at `program_data`.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ HorizonError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::HorizonZero>,
    /// The program's ProgramData `[program_id]` under the upgradeable loader. Its upgrade authority
    /// must be the signer.
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ HorizonError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ HorizonError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    /// Config's `pending_admin`, checked in the handler. Pays the commit intent.
    #[account(mut)]
    pub new_admin: Signer<'info>,
    /// CHECK: committed here, so read and written by hand (see `read_config`, which checks the
    /// address); Anchor must not write a typed Config back after the scheduling CPI
    #[account(mut)]
    pub config: UncheckedAccount<'info>,
    pub magic: MagicAccounts<'info>,
}

#[derive(Accounts)]
#[instruction(battleground_id: u8)]
pub struct CreateBattleground<'info> {
    /// Must be Config's admin, checked in the handler.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: read by hand (see `read_config`), so it works whether or not Config is delegated
    pub config: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Battleground::INIT_SPACE,
        seeds = [b"battleground".as_ref(), &[battleground_id][..]],
        bump
    )]
    pub battleground: Account<'info, Battleground>,
    pub system_program: Program<'info, System>,
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

fn behavior_bytes(behavior: &Behavior) -> Result<&[u8]> {
    let len = behavior.len as usize;
    require!(len <= behavior.body.len(), HorizonError::InvalidBehavior);
    let bytes = &behavior.body[..len];
    require!(BehaviorBody::parse(bytes).is_some(), HorizonError::InvalidBehavior);
    Ok(bytes)
}

/// What creating or closing an ephemeral account needs besides the sponsor and the account.
#[derive(Accounts)]
pub struct EphAccounts<'info> {
    /// CHECK: the ephemeral rent vault
    #[cfg_attr(not(feature = "inline-mock-magic"), account(mut, address = EPH_VAULT))]
    #[cfg_attr(feature = "inline-mock-magic", account(mut))]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the magic program, which creates and closes ephemeral accounts
    #[cfg_attr(not(feature = "inline-mock-magic"), account(address = MAGIC_PROGRAM))]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CreateBehavior<'info> {
    pub creator: Signer<'info>,
    /// Sponsors the behavior's rent.
    #[account(mut, seeds = [b"player", creator.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    /// CHECK: the behavior PDA, created here as an ephemeral account
    #[account(mut)]
    pub behavior: UncheckedAccount<'info>,
    pub ephemeral: EphAccounts<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateArmy<'info> {
    pub owner: Signer<'info>,
    /// Sponsors the army's rent.
    #[account(mut, seeds = [b"player", owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    pub battleground: Account<'info, Battleground>,
    /// CHECK: the army PDA, created here as an ephemeral account
    #[account(mut)]
    pub army: UncheckedAccount<'info>,
    pub ephemeral: EphAccounts<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateArmy<'info> {
    pub owner: Signer<'info>,
    pub battleground: Account<'info, Battleground>,
    #[account(mut, constraint = army.owner == owner.key() @ HorizonError::NotOwner, constraint = army.battleground == battleground.key() @ HorizonError::WrongBattleground)]
    pub army: Account<'info, Army>,
}

#[derive(Accounts)]
pub struct CloseArmy<'info> {
    pub owner: Signer<'info>,
    /// Sponsored the army; gets its rent back.
    #[account(mut, seeds = [b"player", owner.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    /// CHECK: closed here, so read by hand: owner, status and address are checked in the handler
    #[account(mut)]
    pub army: UncheckedAccount<'info>,
    pub ephemeral: EphAccounts<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct LockArmy<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    /// The locker's Player: its budget must cover one stake, and it sponsors the battle.
    #[account(mut, seeds = [b"player".as_ref(), player.key().as_ref()], bump = player_account.bump)]
    pub player_account: Box<Account<'info, Player>>,
    /// Its fee rate is copied onto a new battle.
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub battleground: Account<'info, Battleground>,
    #[account(mut)]
    pub army: Box<Account<'info, Army>>,
    /// CHECK: created when two armies match. Not `mut`, so the IDL marks it read-only: a client
    /// must pass it writable when the lock opens a match, and read-only when it only queues, since
    /// the rollup refuses a transaction that passes a writable account it neither holds nor creates
    pub battle: UncheckedAccount<'info>,
    pub ephemeral: EphAccounts<'info>,
    /// CHECK: oracle queue owned by the VRF program
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UnlockArmy<'info> {
    pub player: Signer<'info>,
    #[account(mut)]
    pub battleground: Account<'info, Battleground>,
    #[account(mut)]
    pub army: Account<'info, Army>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct SeedMatch<'info> {
    #[account(mut)]
    pub battle: Box<Account<'info, Battle>>,
}

/// Permissionless. Each army and Player is checked against the battle in the handler.
#[derive(Accounts)]
pub struct SettleMatch<'info> {
    /// CHECK: closed here, so read by hand and checked against its derivation
    #[account(mut)]
    pub battle: UncheckedAccount<'info>,
    #[account(mut)]
    pub army_a: Box<Account<'info, Army>>,
    #[account(mut)]
    pub army_b: Box<Account<'info, Army>>,
    #[account(mut)]
    pub player_a: Box<Account<'info, Player>>,
    /// Sponsored the battle; gets its rent back.
    #[account(mut)]
    pub player_b: Box<Account<'info, Player>>,
    /// Receives the fee.
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub ephemeral: EphAccounts<'info>,
}

/// Permissionless. The same accounts as `settle_match` but Config, checked the same way.
#[derive(Accounts)]
pub struct CancelMatch<'info> {
    /// CHECK: closed here, so read by hand and checked against its derivation
    #[account(mut)]
    pub battle: UncheckedAccount<'info>,
    #[account(mut)]
    pub army_a: Box<Account<'info, Army>>,
    #[account(mut)]
    pub army_b: Box<Account<'info, Army>>,
    #[account(mut)]
    pub player_a: Box<Account<'info, Player>>,
    /// Sponsored the battle; gets its rent back.
    #[account(mut)]
    pub player_b: Box<Account<'info, Player>>,
    pub ephemeral: EphAccounts<'info>,
}

/// What scheduling a commit needs.
#[derive(Accounts)]
pub struct MagicAccounts<'info> {
    /// CHECK: the magic context, which queues the commit
    #[cfg_attr(not(feature = "inline-mock-magic"), account(mut, address = MAGIC_CONTEXT))]
    #[cfg_attr(feature = "inline-mock-magic", account(mut))]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: the magic program, which schedules the commit and undelegation
    #[cfg_attr(not(feature = "inline-mock-magic"), account(address = MAGIC_PROGRAM))]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FundOutbox<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"player", owner.key().as_ref()], bump = player.bump, has_one = owner @ HorizonError::NotOwner)]
    pub player: Account<'info, Player>,
    #[account(mut, seeds = [b"outbox", owner.key().as_ref()], bump = outbox.bump, has_one = owner @ HorizonError::NotOwner)]
    pub outbox: Account<'info, Outbox>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// Pays the intent.
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: the owner's Player, by its seeds, committed here; the handler checks this program owns
    /// it. Unchecked so Anchor does not write it back after the scheduling CPI.
    #[account(mut, seeds = [b"player", owner.key().as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
    /// CHECK: read by hand (see `read_funded_outbox`); its address is the owner's Outbox
    #[account(mut, seeds = [b"outbox", owner.key().as_ref()], bump)]
    pub outbox: UncheckedAccount<'info>,
    pub magic: MagicAccounts<'info>,
}

#[derive(Accounts)]
pub struct InitTreasuryOutbox<'info> {
    /// Must be Config's admin, checked in the handler.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: read by hand (see `read_config`), so it works whether or not Config is delegated
    pub config: UncheckedAccount<'info>,
    #[account(init, payer = admin, space = 8 + Outbox::INIT_SPACE, seeds = [b"outbox", config.key().as_ref()], bump)]
    pub outbox: Account<'info, Outbox>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundTreasuryOutbox<'info> {
    pub admin: Signer<'info>,
    /// Holds the fees on top of its rent.
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ HorizonError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"outbox", config.key().as_ref()], bump = outbox.bump)]
    pub outbox: Account<'info, Outbox>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    /// Pays the intent.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: committed here, so read by hand (see `require_admin`, which checks the address and the
    /// admin); Anchor must not write a typed Config back after the scheduling CPI
    #[account(mut)]
    pub config: UncheckedAccount<'info>,
    /// CHECK: read by hand (see `read_funded_outbox`); its address is the treasury Outbox
    #[account(mut, seeds = [b"outbox", config.key().as_ref()], bump)]
    pub outbox: UncheckedAccount<'info>,
    pub magic: MagicAccounts<'info>,
}

/// Permissionless. The delegation program's post-undelegate call appends three accounts (the
/// destination program, the escrow authority and the escrow PDA), which stay remaining accounts.
#[derive(Accounts)]
pub struct ReleaseOutbox<'info> {
    /// Typed, so an Outbox still delegated (owned by the delegation program) is refused.
    #[account(mut)]
    pub outbox: Account<'info, Outbox>,
    /// CHECK: only receives lamports; it must be the owner the Outbox records, which may be a
    /// program account such as a multisig
    #[account(mut, address = outbox.owner)]
    pub owner: UncheckedAccount<'info>,
}

// The delegate instructions. `#[delegate]` adds, before each `del` account, its delegation buffer,
// record and metadata, and appends the owner program, the delegation program and the system
// program. A `del` account must be unchecked: once delegated, the delegation program owns it, and
// Anchor must not write a typed account back.

#[cfg(not(feature = "inline-mock-magic"))]
#[delegate]
#[derive(Accounts)]
pub struct DelegatePlayer<'info> {
    /// Pays the delegation rent.
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: the owner's Player, by its seeds; the delegation program takes it over
    #[account(mut, del, seeds = [b"player", owner.key().as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
}

#[cfg(not(feature = "inline-mock-magic"))]
#[delegate]
#[derive(Accounts)]
pub struct DelegateOutbox<'info> {
    /// Pays the delegation rent.
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: the owner's Outbox, by its seeds; read by hand (see `read_outbox`)
    #[account(mut, del, seeds = [b"outbox", owner.key().as_ref()], bump)]
    pub outbox: UncheckedAccount<'info>,
}

#[cfg(not(feature = "inline-mock-magic"))]
#[delegate]
#[derive(Accounts)]
pub struct DelegateConfig<'info> {
    /// Must be Config's admin, checked in the handler. Pays the delegation rent.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: read by hand (see `read_config`)
    #[account(mut, del, seeds = [b"config"], bump)]
    pub config: UncheckedAccount<'info>,
}

#[cfg(not(feature = "inline-mock-magic"))]
#[delegate]
#[derive(Accounts)]
#[instruction(battleground_id: u8)]
pub struct DelegateBattleground<'info> {
    /// Must be Config's admin, checked in the handler. Pays the delegation rent.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: read by hand (see `read_config`), so it works whether or not Config is delegated
    pub config: UncheckedAccount<'info>,
    /// CHECK: the battleground, by its seeds; the delegation program takes it over
    #[account(mut, del, seeds = [b"battleground".as_ref(), &[battleground_id][..]], bump)]
    pub battleground: UncheckedAccount<'info>,
}

#[cfg(not(feature = "inline-mock-magic"))]
#[delegate]
#[derive(Accounts)]
pub struct DelegateTreasuryOutbox<'info> {
    /// Must be Config's admin, checked in the handler. Pays the delegation rent.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: read by hand (see `read_config`), so it works whether or not Config is delegated
    pub config: UncheckedAccount<'info>,
    /// CHECK: the treasury Outbox, by its seeds; read by hand (see `read_outbox`)
    #[account(mut, del, seeds = [b"outbox", config.key().as_ref()], bump)]
    pub outbox: UncheckedAccount<'info>,
}

/// Compute left in this transaction (profiling builds only).
#[cfg(feature = "cu-profile")]
fn remaining_units() -> u64 {
    extern "C" {
        fn sol_remaining_compute_units() -> u64;
    }
    unsafe { sol_remaining_compute_units() }
}

/// Logs what settle_match spent before the simulation, in the combat profile's format as phase 9.
#[cfg(feature = "cu-profile")]
fn log_program_overhead(units: u64) {
    extern "C" {
        fn sol_log_64_(a: u64, b: u64, c: u64, d: u64, e: u64);
    }
    unsafe { sol_log_64_(0xC0FFEE, 9, units, 1, 0) }
}

#[cfg(test)]
mod battle_layout_tests {
    use super::*;

    fn unit(seed: u8) -> SnapshotUnit {
        let mut body = [0u8; MAX_BEHAVIOR_LEN];
        body.iter_mut().enumerate().for_each(|(at, byte)| *byte = seed.wrapping_add(at as u8));
        SnapshotUnit {
            kind: seed,
            len: seed % 77,
            body,
            col: seed.wrapping_add(1),
            row: seed.wrapping_add(2),
            cost: 1000 + seed as u16,
            hp: seed.wrapping_add(3),
            atk: seed.wrapping_add(4),
            range: seed.wrapping_add(5),
            speed: seed.wrapping_add(6),
            cast: CastParams {
                damage: seed.wrapping_add(7),
                range: seed.wrapping_add(8),
                aoe: seed.wrapping_add(9),
                effect: seed.wrapping_add(10),
                aim: seed.wrapping_add(11),
                power: seed.wrapping_add(12),
                rounds: seed.wrapping_add(13),
                cooldown: seed.wrapping_add(14),
            },
            actions: seed.wrapping_add(15),
        }
    }

    fn bytes(value: &impl AnchorSerialize) -> Vec<u8> {
        let mut out = Vec::new();
        value.serialize(&mut out).unwrap();
        out
    }

    fn army(seed: u8, count: u8) -> Army {
        let mut units = [ArmyUnit::default(); MAX_UNITS];
        for (at, slot) in units.iter_mut().enumerate().take(count as usize) {
            let from = unit(seed.wrapping_add(at as u8 * 16));
            *slot = ArmyUnit {
                kind: from.kind,
                behavior: Pubkey::new_unique(),
                len: from.len,
                body: from.body,
                col: from.col,
                row: from.row,
                cost: from.cost,
                hp: from.hp,
                atk: from.atk,
                range: from.range,
                speed: from.speed,
                cast: from.cast,
                actions: from.actions,
            };
        }
        Army {
            owner: Pubkey::new_unique(),
            battleground: Pubkey::new_unique(),
            race: seed % 3,
            index: seed as u32,
            unit_count: count,
            units,
            status: ArmyStatus::Queued,
            bump: seed,
        }
    }

    #[test]
    fn read_battle_mirrors_the_battle_layout() {
        let mut units_a = [SnapshotUnit::default(); MAX_UNITS];
        let mut units_b = [SnapshotUnit::default(); MAX_UNITS];
        (0..4).for_each(|at| units_a[at] = unit(at as u8 * 20));
        (0..7).for_each(|at| units_b[at] = unit(100 + at as u8 * 9));
        let battle = Box::new(Battle {
            battleground: Pubkey::new_unique(),
            army_a: Pubkey::new_unique(),
            army_b: Pubkey::new_unique(),
            player_a: Pubkey::new_unique(),
            player_b: Pubkey::new_unique(),
            stake: 123_456_789,
            seq: 42,
            count_a: 4,
            count_b: 7,
            cols: 10,
            rows: 8,
            units_a,
            units_b,
            status: BattleStatus::Seeded,
            seed: [9; 32],
            outcome: Outcome::Pending,
            race_a: 1,
            race_b: 2,
            fee_bps: 777,
            opened_at: -1_234_567_890_123,
            bump: 253,
        });
        let mut data = Vec::new();
        battle.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), 8 + Battle::INIT_SPACE);

        let read = read_battle(&data).unwrap();
        let (head, tail) = (&read.head, &read.tail);
        assert_eq!(
            (head.battleground, head.army_a, head.army_b, head.player_a, head.player_b),
            (battle.battleground, battle.army_a, battle.army_b, battle.player_a, battle.player_b)
        );
        assert_eq!(
            (head.stake, head.seq, head.count_a, head.count_b, head.cols, head.rows),
            (123_456_789, 42, 4, 7, 10, 8)
        );
        assert_eq!(read.units_a.len(), 4);
        assert_eq!(read.units_b.len(), 7);
        read.units_a.iter().zip(&battle.units_a).for_each(|(got, want)| assert_eq!(bytes(got), bytes(want)));
        read.units_b.iter().zip(&battle.units_b).for_each(|(got, want)| assert_eq!(bytes(got), bytes(want)));
        assert_eq!(
            (tail.status, tail.seed, tail.fee_bps, tail.opened_at, tail.bump),
            (BattleStatus::Seeded, [9; 32], 777, -1_234_567_890_123, 253)
        );
        assert_eq!(i64::from_le_bytes(data[2146..2154].try_into().unwrap()), -1_234_567_890_123, "opened_at offset");
        assert_eq!((u16::from_le_bytes([data[2144], data[2145]]), data[2154]), (777, 253), "fee_bps and bump offsets");
        assert!(read_battle(&data[8..]).is_err(), "a missing discriminator does not read");
    }

    #[test]
    fn write_battle_output_deserializes_as_a_battle() {
        let (army_a, army_b) = (army(3, 4), army(50, 10));
        let head = BattleHead {
            battleground: Pubkey::new_unique(),
            army_a: Pubkey::new_unique(),
            army_b: Pubkey::new_unique(),
            player_a: army_a.owner,
            player_b: army_b.owner,
            stake: 10_000_000,
            seq: 7,
            cols: 12,
            rows: 10,
            fee_bps: 500,
            opened_at: 1_792_016_933,
            bump: 250,
        };
        let mut data = vec![0u8; 8 + Battle::INIT_SPACE];
        write_battle(&mut data, &head, &army_a, &army_b).unwrap();
        let battle = Box::new(Battle::try_deserialize(&mut &data[..]).unwrap());
        assert_eq!(
            (battle.battleground, battle.army_a, battle.army_b, battle.player_a, battle.player_b),
            (head.battleground, head.army_a, head.army_b, head.player_a, head.player_b)
        );
        assert_eq!(
            (battle.stake, battle.seq, battle.count_a, battle.count_b, battle.cols, battle.rows),
            (10_000_000, 7, 4, 10, 12, 10)
        );
        assert_eq!((battle.status, battle.seed, battle.outcome), (BattleStatus::Awaiting, [0; 32], Outcome::Pending));
        assert_eq!((battle.race_a, battle.race_b, battle.fee_bps, battle.bump), (army_a.race, army_b.race, 500, 250));
        assert_eq!(battle.opened_at, 1_792_016_933);
        for (army, units) in [(&army_a, &battle.units_a), (&army_b, &battle.units_b)] {
            for (at, snapshot) in units.iter().enumerate() {
                if at < army.unit_count as usize {
                    let from = &army.units[at];
                    assert_eq!((snapshot.kind, snapshot.len, snapshot.body), (from.kind, from.len, from.body));
                    assert_eq!(
                        (snapshot.col, snapshot.row, snapshot.cost, snapshot.actions),
                        (from.col, from.row, from.cost, from.actions)
                    );
                    assert_eq!(
                        (snapshot.hp, snapshot.atk, snapshot.range, snapshot.speed),
                        (from.hp, from.atk, from.range, from.speed)
                    );
                    assert_eq!(bytes(&snapshot.cast), bytes(&from.cast));
                } else {
                    assert_eq!(bytes(snapshot), bytes(&SnapshotUnit::default()), "unused slot {at} is zero");
                }
            }
        }
    }
}
