//! Settlement through a one-shot Hydra crank.
//!
//! The VRF callback stores the seed and creates a crank that runs `settle_match` once, as soon as a
//! cranker picks it up. A cranker sends `Trigger` followed by the scheduled `settle_match`; Hydra
//! checks that the follow-up matches the stored template, and `settle_match` checks through the
//! instructions sysvar that it directly follows that `Trigger`. The crank is paid for from a vault
//! the matching player funds in `lock_army`, and `settle_match` cancels it to refund that player.
//! The stakes themselves come from and return to the two players' pots.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use anchor_lang::Discriminator;

use crate::error::HorizonError;
use crate::ID;

/// The base-layer Hydra program, on devnet and mainnet.
pub const HYDRA_ID: Pubkey = pubkey!("Hydra17i1feui9deaxu6d1TzSQMRNHeBRkDR1Awy7zea");
/// What Hydra pays the cranker per trigger on the base layer.
pub const CRANKER_REWARD: u64 = 10_000;
/// The settlement uses up to a full transaction; the worst benchmarked battle needs about half.
pub const CRANK_CU_LIMIT: u32 = 1_400_000;
pub const CRANK_FUND_SEED: &[u8] = b"crank-fund";

const CREATE: u8 = 0;
const TRIGGER: u8 = 1;
const CANCEL: u8 = 2;
const WRITABLE: u8 = 0b10;
/// `settle_match`'s accounts, in `SettleMatch` order.
const SETTLE_ACCOUNTS: usize = 9;
const SETTLE_DATA: usize = 8;
/// Hydra's header, then the scheduled instruction as the instructions sysvar lays it out:
/// account count, `[flag, pubkey]` per account, program id, data length, data.
pub const CRANK_SIZE: usize = 120 + 2 + 33 * SETTLE_ACCOUNTS + 32 + 2 + SETTLE_DATA;

/// What `lock_army` puts in the vault: the crank's rent plus one cranker reward.
pub fn crank_funding() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(CRANK_SIZE) + CRANKER_REWARD)
}

/// The system-owned vault that pays for a battle's crank: `[b"crank-fund", battle]`.
pub fn crank_fund_pda(battle: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CRANK_FUND_SEED, battle.as_ref()], &ID)
}

/// The battle's crank under Hydra, bound to the vault as payer and seeded with the battle key.
pub fn crank_pda(fund: &Pubkey, battle: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"crank", fund.as_ref(), battle.as_ref()], &HYDRA_ID).0
}

/// The accounts the crank passes to `settle_match`. Hydra stores only the writable bit, and the
/// runtime promotes the crank to writable because `Trigger` writes it, so it is writable here too.
fn settle_metas(battle: &crate::state::Battle, battle_key: Pubkey, crank: Pubkey) -> [(Pubkey, bool); SETTLE_ACCOUNTS] {
    [
        (battle_key, true),
        (battle.army_a, true),
        (battle.army_b, true),
        (crate::pot_pda(&battle.battleground, &battle.player_a), true),
        (crate::pot_pda(&battle.battleground, &battle.player_b), true),
        (battle.player_b, true),
        (crank, true),
        (HYDRA_ID, false),
        (solana_instructions_sysvar::ID, false),
    ]
}

/// Creates the battle's one-shot crank from the vault, then moves the rest of the vault into it as
/// the cranker's reward. The crank's cancel authority is the battle, so only this program closes it.
pub fn create_settle_crank<'info>(
    battle: &crate::state::Battle,
    battle_key: Pubkey,
    fund: &AccountInfo<'info>,
    fund_bump: u8,
    crank: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
) -> Result<()> {
    let mut data = Vec::with_capacity(1 + 100 + 35 + 33 * SETTLE_ACCOUNTS + SETTLE_DATA);
    data.push(CREATE);
    data.extend_from_slice(battle_key.as_ref()); // seed
    data.extend_from_slice(battle_key.as_ref()); // cancel authority
    data.extend_from_slice(&Clock::get()?.slot.to_le_bytes()); // start now
    data.extend_from_slice(&0u64.to_le_bytes()); // interval
    data.extend_from_slice(&1u64.to_le_bytes()); // runs once
    data.extend_from_slice(&0u64.to_le_bytes()); // priority tip
    data.extend_from_slice(&CRANK_CU_LIMIT.to_le_bytes());
    data.push(SETTLE_ACCOUNTS as u8);
    data.extend_from_slice(&(SETTLE_DATA as u16).to_le_bytes());
    data.extend_from_slice(ID.as_ref());
    for (key, writable) in settle_metas(battle, battle_key, *crank.key) {
        data.push(if writable { WRITABLE } else { 0 });
        data.extend_from_slice(key.as_ref());
    }
    data.extend_from_slice(crate::instruction::SettleMatch::DISCRIMINATOR);

    let seeds: &[&[u8]] = &[CRANK_FUND_SEED, battle_key.as_ref(), &[fund_bump]];
    invoke_signed(
        &Instruction {
            program_id: HYDRA_ID,
            accounts: vec![
                AccountMeta::new(*fund.key, true),
                AccountMeta::new(*crank.key, false),
                AccountMeta::new_readonly(*system.key, false),
            ],
            data,
        },
        &[fund.clone(), crank.clone(), system.clone()],
        &[seeds],
    )?;
    // Hydra took the rent; the rest pays the cranker. The vault ends empty.
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            system.key(),
            anchor_lang::system_program::Transfer { from: fund.clone(), to: crank.clone() },
            &[seeds],
        ),
        fund.lamports(),
    )
}

/// Fails unless this instruction is top level and directly follows Hydra's `Trigger` on `crank`.
/// Hydra in turn checks that this instruction is the crank's stored template, so together they
/// bind the settlement to the battle's crank.
pub fn require_cranked(instructions: &AccountInfo, crank: &Pubkey) -> Result<()> {
    require!(get_stack_height() == 1, HorizonError::NotCranked);
    let current = load_current_index_checked(instructions)?;
    require!(current > 0, HorizonError::NotCranked);
    let trigger = load_instruction_at_checked(current as usize - 1, instructions)?;
    require!(
        trigger.program_id == HYDRA_ID
            && trigger.data == [TRIGGER]
            && trigger.accounts.first().is_some_and(|meta| meta.pubkey == *crank),
        HorizonError::NotCranked
    );
    Ok(())
}

/// Closes the spent crank and sends its balance (its rent) to `recipient`. The battle signs as the
/// crank's authority.
pub fn cancel_crank<'info>(
    battle: &AccountInfo<'info>,
    battle_seeds: &[&[u8]],
    crank: &AccountInfo<'info>,
    recipient: &AccountInfo<'info>,
) -> Result<()> {
    invoke_signed(
        &Instruction {
            program_id: HYDRA_ID,
            accounts: vec![
                AccountMeta::new_readonly(*battle.key, true),
                AccountMeta::new(*crank.key, false),
                AccountMeta::new(*recipient.key, false),
            ],
            data: vec![CANCEL],
        },
        &[battle.clone(), crank.clone(), recipient.clone()],
        &[battle_seeds],
    )?;
    Ok(())
}
