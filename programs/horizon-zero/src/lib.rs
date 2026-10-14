use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount};
use ephemeral_vrf_sdk::anchor::{vrf, vrf_callback};
use ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID;
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;
use horizon_combat::{
    behavior_hash, simulate_winner, Aim, BehaviorBody, Effect, Geometry, Side, SnapshotUnit as CombatUnit,
    MAX_BEHAVIOR_LEN, ZONE_DEPTH,
};

mod crank;
mod eph;
mod error;
mod fees;
mod state;

use error::HorizonError;
use state::*;

declare_id!("Hm19JfKaKCRphRwF7DbxhJWmLpHgMG1SnEnKGRyN9Z7c");

#[cfg(feature = "inline-mock-vrf")]
fn program_identity_bump() -> u8 {
    Pubkey::find_program_address(&[b"identity"], &ID).1
}

#[program]
pub mod horizon_zero {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.config.admin = ctx.accounts.admin.key();
        ctx.accounts.config.bump = ctx.bumps.config;
        let (identity, bump) = Pubkey::find_program_address(&[b"identity"], &ID);
        require_keys_eq!(identity, ctx.accounts.identity.key(), HorizonError::BadPda);
        create_program_account(
            ctx.accounts.admin.to_account_info(),
            ctx.accounts.identity.to_account_info(),
            0,
            &[b"identity", &[bump]],
        )?;
        Ok(())
    }

    pub fn create_battleground(
        ctx: Context<CreateBattleground>,
        battleground_id: u8,
        budget: u16,
        stake_lamports: u64,
        cols: u8,
        rows: u8,
    ) -> Result<()> {
        require_keys_eq!(ctx.accounts.admin.key(), ctx.accounts.config.admin, HorizonError::NotAdmin);
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

    pub fn create_behavior(ctx: Context<CreateBehavior>, hash: [u8; 32], body: Vec<u8>) -> Result<()> {
        require!(BehaviorBody::parse(&body).is_some(), HorizonError::InvalidBehavior);
        require!(behavior_hash(&body) == hash, HorizonError::HashMismatch);
        let behavior = &mut ctx.accounts.behavior;
        behavior.creator = ctx.accounts.creator.key();
        behavior.len = body.len() as u8;
        behavior.body = [0u8; MAX_BEHAVIOR_LEN];
        behavior.body[..body.len()].copy_from_slice(&body);
        behavior.bump = ctx.bumps.behavior;
        msg!("HZ_BEHAVIOR {} {} {}", behavior.key(), behavior.creator, behavior.len);
        Ok(())
    }

    pub fn create_army(ctx: Context<CreateArmy>, index: u32, race: u8, units: Vec<UnitInput>) -> Result<()> {
        let stored = load_units(
            race,
            &units,
            ctx.remaining_accounts,
            ctx.accounts.battleground.budget,
            ctx.accounts.battleground.cols,
        )?;
        let army = &mut ctx.accounts.army;
        army.owner = ctx.accounts.owner.key();
        army.battleground = ctx.accounts.battleground.key();
        army.race = race;
        army.index = index;
        army.unit_count = stored.len() as u8;
        army.units = [ArmyUnit::default(); MAX_UNITS];
        army.units[..stored.len()].copy_from_slice(&stored);
        army.status = ArmyStatus::Idle;
        army.bump = ctx.bumps.army;
        msg!("HZ_ARMY {} {} {}", army.key(), army.owner, army.battleground);
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

    /// Moves `amount` from the owner into their pot for this battleground, creating the pot first.
    pub fn fund_pot(ctx: Context<FundPot>, amount: u64) -> Result<()> {
        let pot = &mut ctx.accounts.pot;
        if pot.owner == Pubkey::default() {
            pot.owner = ctx.accounts.owner.key();
            pot.battleground = ctx.accounts.battleground.key();
            pot.bump = ctx.bumps.pot;
        }
        transfer_sol(&ctx.accounts.owner, &pot.to_account_info(), amount)?;
        pot.budget = pot.budget.checked_add(amount).ok_or(HorizonError::PotShort)?;
        log_pot(&pot.key(), pot);
        Ok(())
    }

    /// Returns `amount` to the owner, taken from the winnings first, then from the budget. Queued
    /// armies stay queued; while the budget is under one stake, no locker can match them.
    pub fn withdraw_pot(ctx: Context<OwnPot>, amount: u64) -> Result<()> {
        let pot = &mut ctx.accounts.pot;
        require!(amount <= pot.winnings.saturating_add(pot.budget), HorizonError::PotShort);
        let from_winnings = amount.min(pot.winnings);
        pot.winnings -= from_winnings;
        pot.budget -= amount - from_winnings;
        move_lamports(&pot.to_account_info(), &ctx.accounts.owner.to_account_info(), amount)?;
        log_pot(&pot.key(), pot);
        Ok(())
    }

    /// On, payouts go to the winnings and are never staked again. Off, they refill the budget.
    /// Switching does not move what either balance already holds.
    pub fn set_segregation(ctx: Context<OwnPot>, segregate: bool) -> Result<()> {
        ctx.accounts.pot.segregate = segregate;
        log_pot(&ctx.accounts.pot.key(), &ctx.accounts.pot);
        Ok(())
    }

    /// Returns the whole pot, rent included, once none of the owner's battles there is unsettled.
    pub fn close_pot(ctx: Context<ClosePot>) -> Result<()> {
        require!(ctx.accounts.pot.fighting == 0, HorizonError::PotBusy);
        msg!("HZ_POT_CLOSE {}", ctx.accounts.pot.key());
        Ok(())
    }

    /// Deletes an idle army and returns its rent to the owner. A queued army must unlock first;
    /// past battles keep their own unit snapshots.
    pub fn close_army(ctx: Context<CloseArmy>) -> Result<()> {
        require!(ctx.accounts.army.status == ArmyStatus::Idle, HorizonError::BadStatus);
        msg!("HZ_ARMY_CLOSE {}", ctx.accounts.army.key());
        Ok(())
    }

    pub fn lock_army<'info>(ctx: Context<'info, LockArmy<'info>>) -> Result<()> {
        let player = ctx.accounts.player.key();
        require!(ctx.accounts.army.owner == player, HorizonError::NotOwner);
        require!(ctx.accounts.army.battleground == ctx.accounts.battleground.key(), HorizonError::WrongBattleground);
        require!(ctx.accounts.army.status == ArmyStatus::Idle, HorizonError::BadStatus);
        require!(ctx.accounts.army.unit_count > 0, HorizonError::TooManyUnits);
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
        require!(ctx.accounts.oracle_queue.owner == &VRF_PROGRAM_ID, HorizonError::BadQueue);
        recheck_behaviors(&ctx.accounts.army, ctx.remaining_accounts)?;

        let stake = ctx.accounts.battleground.stake_lamports;
        require!(ctx.accounts.pot.budget >= stake, HorizonError::PotTooLow);
        let candidates = queued_opponents(&ctx.accounts.battleground, player, stake, ctx.remaining_accounts)?;
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

    /// The VRF callback. Stores the seed and schedules the settlement on a one-shot Hydra crank:
    /// a whole battle does not fit in the compute the oracle gives its callback.
    pub fn seed_match(ctx: Context<SeedMatch>, randomness: [u8; 32]) -> Result<()> {
        let battle_key = ctx.accounts.battle.key();
        let battle = &mut ctx.accounts.battle;
        require!(battle.status == BattleStatus::Awaiting, HorizonError::AlreadyResolved);
        battle_seeds(battle, &battle_key)?;
        let (fund, fund_bump) = crank::crank_fund_pda(&battle_key);
        require_keys_eq!(fund, ctx.accounts.crank_fund.key(), HorizonError::BadPda);
        require_keys_eq!(crank::crank_pda(&fund, &battle_key), ctx.accounts.crank.key(), HorizonError::BadCrank);

        battle.seed = randomness;
        battle.status = BattleStatus::Seeded;
        crank::create_settle_crank(
            battle,
            battle_key,
            &ctx.accounts.crank_fund.to_account_info(),
            fund_bump,
            &ctx.accounts.crank.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
        )?;
        msg!("HZ_MATCH_SEEDED {} {} {}", battle_key, ctx.accounts.crank.key(), hex32(&randomness));
        Ok(())
    }

    /// Runs the battle on the stored seed and pays out. Only a Hydra crank calls it: it must
    /// directly follow `Trigger` on this battle's crank, which it then cancels to refund the player
    /// who funded it.
    pub fn settle_match(ctx: Context<SettleMatch>) -> Result<()> {
        #[cfg(feature = "cu-profile")]
        let entered = remaining_units();
        let battle_key = ctx.accounts.battle.key();
        let battle = &mut ctx.accounts.battle;
        require!(battle.status == BattleStatus::Seeded, HorizonError::AlreadyResolved);
        require!(ctx.accounts.army_a.status == ArmyStatus::Fighting, HorizonError::BadStatus);
        require!(ctx.accounts.army_b.status == ArmyStatus::Fighting, HorizonError::BadStatus);
        battle_seeds(battle, &battle_key)?;
        let (fund, _) = crank::crank_fund_pda(&battle_key);
        let crank_key = crank::crank_pda(&fund, &battle_key);
        require_keys_eq!(crank_key, ctx.accounts.crank.key(), HorizonError::BadCrank);
        crank::require_cranked(&ctx.accounts.instructions, &crank_key)?;

        let side_a = combat_units(&battle.units_a, battle.count_a)?;
        let side_b = combat_units(&battle.units_b, battle.count_b)?;
        // The trace is replayed off-chain; the program only needs the winner.
        #[cfg(feature = "cu-profile")]
        let before = remaining_units();
        let winner = simulate_winner(
            &side_a,
            &side_b,
            battle.seed,
            Geometry { cols: battle.cols as i32, rows: battle.rows as i32 },
        );
        #[cfg(feature = "cu-profile")]
        log_program_overhead(entered - before);
        let stake = battle.stake;
        let info = battle.to_account_info();
        // Before the payout: the runtime checks at a CPI that lamports moved only between the
        // accounts it is given.
        let (ground, seq, bump) = (battle.battleground, battle.seq.to_le_bytes(), [battle.bump]);
        crank::cancel_crank(
            &info,
            &[b"match", ground.as_ref(), &seq, &bump],
            &ctx.accounts.crank.to_account_info(),
            &ctx.accounts.player_b.to_account_info(),
        )?;
        let rent = Rent::get()?.minimum_balance(info.data_len());
        let held = info.lamports().checked_sub(rent).ok_or(HorizonError::NoStake)?;
        require!(held >= stake.saturating_mul(2), HorizonError::NoStake);

        let outcome = match winner {
            Some(Side::A) => Outcome::A,
            Some(Side::B) => Outcome::B,
            None => Outcome::Draw,
        };
        let (paid_a, paid_b) = match outcome {
            Outcome::A => (stake * 2, 0),
            Outcome::B => (0, stake * 2),
            _ => (stake, stake),
        };
        for (pot, paid) in [(&mut ctx.accounts.pot_a, paid_a), (&mut ctx.accounts.pot_b, paid_b)] {
            move_lamports(&info, &pot.to_account_info(), paid)?;
            pot.credit(paid);
            pot.fighting = pot.fighting.saturating_sub(1);
            log_pot(&pot.key(), pot);
        }

        battle.status = BattleStatus::Resolved;
        battle.outcome = outcome;
        ctx.accounts.army_a.status = ArmyStatus::Idle;
        ctx.accounts.army_b.status = ArmyStatus::Idle;
        let seed = battle.seed;
        msg!("HZ_MATCH_RESOLVED {} {} {}", battle_key, outcome as u8, hex32(&seed));
        Ok(())
    }
}

/// Checks the battle address against its stored canonical bump (lock_army created it with that
/// bump), one derivation instead of a bump search.
fn battle_seeds(battle: &Battle, key: &Pubkey) -> Result<()> {
    let derived = Pubkey::create_program_address(
        &[b"match", battle.battleground.as_ref(), &battle.seq.to_le_bytes(), &[battle.bump]],
        &ID,
    )
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
    let hash = recent_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
    let pick = (u64::from_le_bytes(hash[..8].try_into().unwrap()) as usize) % candidates.len();
    let (opponent_key, opponent_pot_at) = candidates[pick];
    let opponent = account_by_key(ctx.remaining_accounts, &opponent_key)?;
    let opponent_pot = ctx.remaining_accounts[opponent_pot_at].clone();
    let mut opponent_pot_state = Pot::try_deserialize(&mut &opponent_pot.try_borrow_data()?[..])?;
    let mut opponent_army = Box::new(Army::try_deserialize(&mut &opponent.try_borrow_data()?[..])?);
    let opponent_owner = opponent_army.owner;
    require!(opponent_army.status == ArmyStatus::Queued, HorizonError::BadStatus);
    require!(opponent_army.owner != player, HorizonError::OwnArmy);

    let seq = ctx.accounts.battleground.match_seq;
    let (battle_key, battle_bump) =
        Pubkey::find_program_address(&[b"match", ctx.accounts.battleground.key().as_ref(), &seq.to_le_bytes()], &ID);
    require_keys_eq!(battle_key, ctx.accounts.battle.key(), HorizonError::BadMatch);
    let battle_space = 8 + Battle::INIT_SPACE;
    let battle_rent = Rent::get()?.minimum_balance(battle_space);
    create_program_account_with_lamports(
        ctx.accounts.player.to_account_info(),
        ctx.accounts.battle.to_account_info(),
        battle_space,
        battle_rent,
        &[b"match", ctx.accounts.battleground.key().as_ref(), &seq.to_le_bytes(), &[battle_bump]],
    )?;

    {
        let mut data = ctx.accounts.battle.try_borrow_mut_data()?;
        let head = BattleHead {
            battleground: ctx.accounts.battleground.key(),
            army_a: opponent_key,
            army_b: ctx.accounts.army.key(),
            player_a: opponent_owner,
            player_b: player,
            stake,
            seq,
            cols: ctx.accounts.battleground.cols,
            rows: ctx.accounts.battleground.rows,
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
    // Both stakes leave the pots after the VRF request: the runtime checks at a CPI that lamports
    // moved only between the accounts it is given.
    for pot in [&mut *ctx.accounts.pot, &mut opponent_pot_state] {
        pot.budget -= stake;
        pot.fighting = pot.fighting.checked_add(1).ok_or(HorizonError::PotBusy)?;
    }
    opponent_pot_state.try_serialize(&mut opponent_pot.try_borrow_mut_data()?.as_mut())?;
    ctx.accounts.army.exit(&ID)?;
    ctx.accounts.battleground.exit(&ID)?;
    ctx.accounts.pot.exit(&ID)?;

    // The vault that pays for the settlement crank. It must end the callback empty, so it holds
    // exactly the crank's rent and reward, topped up if someone sent it lamports already.
    let (fund_key, _) = crank::crank_fund_pda(&battle_key);
    let fund = account_by_key(ctx.remaining_accounts, &fund_key)?;
    let funding = crank::crank_funding()?.saturating_sub(fund.lamports());
    if funding > 0 {
        transfer_sol(&ctx.accounts.player, &fund, funding)?;
    }

    request_vrf(&ctx, &fund_key)?;
    move_lamports(&ctx.accounts.pot.to_account_info(), &ctx.accounts.battle, stake)?;
    move_lamports(&opponent_pot, &ctx.accounts.battle, stake)?;
    log_pot(&ctx.accounts.pot.key(), &ctx.accounts.pot);
    log_pot(opponent_pot.key, &opponent_pot_state);
    msg!("HZ_MATCH_OPEN {} {} {} {}", battle_key, opponent_key, ctx.accounts.army.key(), stake);
    Ok(())
}

fn request_vrf<'info>(ctx: &Context<'info, LockArmy<'info>>, fund: &Pubkey) -> Result<()> {
    let battle = ctx.accounts.battle.key();
    let seed = horizon_combat::sha256(&[battle.as_ref()]);
    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.player.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: ID,
        callback_discriminator: instruction::SeedMatch::DISCRIMINATOR.to_vec(),
        caller_seed: seed,
        accounts_metas: Some(vec![
            meta(battle, true),
            meta(*fund, true),
            meta(crank::crank_pda(fund, &battle), true),
            meta(crank::HYDRA_ID, false),
            meta(system_program::ID, false),
        ]),
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

fn recheck_behaviors(army: &Army, accounts: &[AccountInfo]) -> Result<()> {
    for unit in army.units.iter().take(army.unit_count as usize) {
        let account = accounts
            .iter()
            .find(|account| account.key.to_string() == unit.behavior.to_string())
            .ok_or(HorizonError::MissingBehavior)?;
        let behavior = Behavior::try_deserialize(&mut &account.try_borrow_data()?[..])?;
        let bytes = behavior_bytes(&behavior)?;
        require!(bytes == &unit.body[..unit.len as usize], HorizonError::HashMismatch);
    }
    Ok(())
}

/// The queued armies a locker may meet, each with the index of its owner's pot in `accounts`. An
/// army whose owner has no pot there, or whose pot no longer covers the stake, is skipped.
fn queued_opponents(ground: &Account<Battleground>, player: Pubkey, stake: u64, accounts: &[AccountInfo]) -> Result<Vec<(Pubkey, usize)>> {
    // Every pot is a program account at its PDA, so a program-owned `Pot` is genuine.
    let mut pots = Vec::new();
    for (at, account) in accounts.iter().enumerate() {
        if account.owner == &ID && account.data_len() == 8 + Pot::INIT_SPACE {
            if let Ok(pot) = Pot::try_deserialize(&mut &account.try_borrow_data()?[..]) {
                if pot.battleground == ground.key() && pot.budget >= stake {
                    pots.push((pot.owner, at));
                }
            }
        }
    }
    let mut found = Vec::new();
    for key in ground.queue[..ground.queue_len as usize].iter() {
        if let Some(account) = accounts.iter().find(|account| account.key == key) {
            let army = Army::try_deserialize(&mut &account.try_borrow_data()?[..])?;
            if army.owner == player || army.status != ArmyStatus::Queued {
                continue;
            }
            if let Some(&(_, at)) = pots.iter().find(|(owner, _)| *owner == army.owner) {
                found.push((*key, at));
            }
        }
    }
    Ok(found)
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
    let want = key.to_string();
    accounts
        .iter()
        .find(|account| account.key.to_string() == want)
        .cloned()
        .ok_or_else(|| error!(HorizonError::MissingAccount))
}

fn create_program_account<'info>(
    payer: AccountInfo<'info>,
    account: AccountInfo<'info>,
    space: usize,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(space);
    create_program_account_with_lamports(payer, account, space, rent, signer_seeds)
}

fn create_program_account_with_lamports<'info>(
    payer: AccountInfo<'info>,
    account: AccountInfo<'info>,
    space: usize,
    lamports: u64,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    system_program::create_account(
        CpiContext::new_with_signer(system_program::ID, CreateAccount { from: payer, to: account }, &[signer_seeds]),
        lamports,
        space as u64,
        &ID,
    )
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
    require!(from.lamports() >= lamports, HorizonError::NoStake);
    **from.try_borrow_mut_lamports()? -= lamports;
    **to.try_borrow_mut_lamports()? += lamports;
    Ok(())
}

/// A player's pot on a battleground: `[b"pot", battleground, owner]`.
pub fn pot_pda(battleground: &Pubkey, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"pot", battleground.as_ref(), owner.as_ref()], &ID).0
}

fn log_pot(key: &Pubkey, pot: &Pot) {
    msg!("HZ_POT {} {} {} {} {} {}", key, pot.owner, pot.budget, pot.winnings, pot.segregate as u8, pot.fighting);
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
}

#[derive(Accounts)]
#[instruction(battleground_id: u8)]
pub struct CreateBattleground<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
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

fn behavior_bytes(behavior: &Behavior) -> Result<&[u8]> {
    let len = behavior.len as usize;
    require!(len <= behavior.body.len(), HorizonError::InvalidBehavior);
    let bytes = &behavior.body[..len];
    require!(BehaviorBody::parse(bytes).is_some(), HorizonError::InvalidBehavior);
    Ok(bytes)
}

#[derive(Accounts)]
#[instruction(hash: [u8; 32])]
pub struct CreateBehavior<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Behavior::INIT_SPACE,
        seeds = [b"behavior".as_ref(), hash.as_ref()],
        bump
    )]
    pub behavior: Account<'info, Behavior>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u32)]
pub struct CreateArmy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub battleground: Account<'info, Battleground>,
    #[account(
        init,
        payer = owner,
        space = 8 + Army::INIT_SPACE,
        seeds = [b"army".as_ref(), owner.key().as_ref(), index.to_le_bytes().as_ref()],
        bump
    )]
    pub army: Account<'info, Army>,
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
pub struct FundPot<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub battleground: Account<'info, Battleground>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Pot::INIT_SPACE,
        seeds = [b"pot".as_ref(), battleground.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub pot: Account<'info, Pot>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnPot<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ HorizonError::NotOwner)]
    pub pot: Account<'info, Pot>,
}

#[derive(Accounts)]
pub struct ClosePot<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, close = owner, has_one = owner @ HorizonError::NotOwner)]
    pub pot: Account<'info, Pot>,
}

#[derive(Accounts)]
pub struct CloseArmy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, close = owner, constraint = army.owner == owner.key() @ HorizonError::NotOwner)]
    pub army: Account<'info, Army>,
}

#[vrf]
#[derive(Accounts)]
pub struct LockArmy<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut)]
    pub battleground: Account<'info, Battleground>,
    #[account(mut)]
    pub army: Box<Account<'info, Army>>,
    /// The locker's pot on this battleground; it must cover one stake.
    #[account(mut, seeds = [b"pot".as_ref(), battleground.key().as_ref(), player.key().as_ref()], bump = pot.bump)]
    pub pot: Box<Account<'info, Pot>>,
    /// CHECK: created when two armies match
    #[account(mut)]
    pub battle: UncheckedAccount<'info>,
    /// CHECK: oracle queue owned by the VRF program
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UnlockArmy<'info> {
    #[account(mut)]
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
    /// CHECK: the battle's crank vault, checked against its derivation
    #[account(mut)]
    pub crank_fund: UncheckedAccount<'info>,
    /// CHECK: the battle's crank, checked against its derivation and created by Hydra
    #[account(mut)]
    pub crank: UncheckedAccount<'info>,
    /// CHECK: the Hydra program
    #[account(address = crank::HYDRA_ID)]
    pub hydra_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// The order is the crank's stored template (see `crank::settle_metas`).
#[derive(Accounts)]
pub struct SettleMatch<'info> {
    #[account(mut)]
    pub battle: Box<Account<'info, Battle>>,
    #[account(mut, constraint = army_a.key() == battle.army_a @ HorizonError::BadPda)]
    pub army_a: Box<Account<'info, Army>>,
    #[account(mut, constraint = army_b.key() == battle.army_b @ HorizonError::BadPda)]
    pub army_b: Box<Account<'info, Army>>,
    #[account(mut, seeds = [b"pot".as_ref(), battle.battleground.as_ref(), battle.player_a.as_ref()], bump = pot_a.bump)]
    pub pot_a: Box<Account<'info, Pot>>,
    #[account(mut, seeds = [b"pot".as_ref(), battle.battleground.as_ref(), battle.player_b.as_ref()], bump = pot_b.bump)]
    pub pot_b: Box<Account<'info, Pot>>,
    /// Receives the crank's rent: player B funded the crank.
    #[account(mut, constraint = player_b.key() == battle.player_b @ HorizonError::BadPda)]
    pub player_b: SystemAccount<'info>,
    /// CHECK: the battle's crank, checked against its derivation
    #[account(mut)]
    pub crank: UncheckedAccount<'info>,
    /// CHECK: the Hydra program
    #[account(address = crank::HYDRA_ID)]
    pub hydra_program: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
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
