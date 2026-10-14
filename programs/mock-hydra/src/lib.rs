//! Stand-in for the base-layer Hydra crank program, installed at the real Hydra id in LiteSVM and in
//! the local stack. It follows the account layout and checks of `hydra-api` 0.2.0: `Create` stores
//! the scheduled instructions in their instructions-sysvar form, `Trigger` must run top level and
//! byte-match the instruction after it, pays the cranker, and counts the run down; `Cancel` and
//! `Close` drain the crank. Only payer-bound crank addresses (`[b"crank", payer, seed]`) are accepted. Like the real
//! program, `Create` also takes an address someone already sent lamports to.

use solana_program::account_info::AccountInfo;
use solana_program::clock::Clock;
use solana_program::entrypoint::ProgramResult;
use solana_program::instruction::{get_stack_height, AccountMeta, Instruction, TRANSACTION_LEVEL_STACK_HEIGHT};
use solana_program::program::invoke_signed;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;
use solana_program::rent::Rent;
use solana_program::sysvar::Sysvar;

solana_program::declare_id!("Hydra17i1feui9deaxu6d1TzSQMRNHeBRkDR1Awy7zea");

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

const HEADER: usize = 120;
const PREFIX: usize = 100;
const IX_HEADER: usize = 35;
const META: usize = 33;
const MAX_ACCOUNTS: usize = 32;
const MAX_DATA_LEN: usize = 1024;
const MAX_INSTRUCTIONS: usize = 16;
const MAX_CU_LIMIT: u32 = 1_400_000;
const INFINITE: u64 = u64::MAX;
const SIGNER: u8 = 1;
pub const CRANKER_REWARD: u64 = 10_000;
const STALE_SLOTS: u64 = 10 * 86_400_000 / 400;

// Header offsets, as `hydra_api::state::Crank`.
const AUTHORITY: usize = 0;
const SEED: usize = 32;
const NEXT_EXEC: usize = 64;
const INTERVAL: usize = 72;
const REMAINING: usize = 80;
const TIP: usize = 88;
const EXECUTED: usize = 96;
const RENT_MIN: usize = 104;
const REGION_LEN: usize = 112;
const BUMP: usize = 114;
const CU_LIMIT: usize = 115;
const AUTHORITY_SIGNER: usize = 119;

/// Hydra's error codes, as custom program errors.
fn hydra_error(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}
const NOT_YET_EXECUTABLE: u32 = 1;
const EXHAUSTED: u32 = 2;
const INSUFFICIENT_FUNDS: u32 = 3;
const UNAUTHORIZED: u32 = 4;
const NOT_CLOSABLE: u32 = 5;
const MISSING_FOLLOWUP: u32 = 6;
const MISMATCHED_FOLLOWUP: u32 = 7;
const SIGNER_IN_SCHEDULE: u32 = 8;
const INVALID_SCHEDULE: u32 = 9;

pub fn process_instruction<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], data: &[u8]) -> ProgramResult {
    if program_id != &ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    match data.first() {
        Some(0) => create(accounts, &data[1..]),
        Some(1) => trigger(accounts),
        Some(2) => cancel(accounts),
        Some(3) => close(accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn u64_at(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}

fn put_u64(data: &mut [u8], at: usize, value: u64) {
    data[at..at + 8].copy_from_slice(&value.to_le_bytes());
}

fn accounts_at<'a, 'b, const N: usize>(accounts: &'b [AccountInfo<'a>]) -> Result<&'b [AccountInfo<'a>; N], ProgramError> {
    accounts.get(..N).and_then(|slice| slice.try_into().ok()).ok_or(ProgramError::NotEnoughAccountKeys)
}

/// The scheduled instructions in sysvar form: `[count u16][flag, pubkey]* [program 32][len u16][data]`.
fn region(data: &[u8]) -> Result<Vec<u8>, ProgramError> {
    let mut out = Vec::new();
    let mut cursor = PREFIX;
    let mut count = 0;
    while cursor < data.len() {
        if cursor + IX_HEADER > data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }
        let accounts = data[cursor] as usize;
        let len = u16::from_le_bytes([data[cursor + 1], data[cursor + 2]]) as usize;
        if accounts > MAX_ACCOUNTS || len > MAX_DATA_LEN {
            return Err(hydra_error(INVALID_SCHEDULE));
        }
        count += 1;
        if count > MAX_INSTRUCTIONS {
            return Err(hydra_error(INVALID_SCHEDULE));
        }
        let metas = cursor + IX_HEADER;
        let body = metas + accounts * META;
        let next = body + len;
        if next > data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }
        if (0..accounts).any(|index| data[metas + index * META] & SIGNER != 0) {
            return Err(hydra_error(SIGNER_IN_SCHEDULE));
        }
        out.extend_from_slice(&(accounts as u16).to_le_bytes());
        out.extend_from_slice(&data[metas..body]);
        out.extend_from_slice(&data[cursor + 3..cursor + IX_HEADER]);
        out.extend_from_slice(&(len as u16).to_le_bytes());
        out.extend_from_slice(&data[body..next]);
        cursor = next;
    }
    if count == 0 || out.len() > u16::MAX as usize {
        return Err(hydra_error(INVALID_SCHEDULE));
    }
    Ok(out)
}

/// Accounts: `[payer(w,s), crank(w), system_program]`.
fn create<'a>(accounts: &[AccountInfo<'a>], data: &[u8]) -> ProgramResult {
    let [payer, crank, system] = accounts_at::<3>(accounts)?;
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < PREFIX + IX_HEADER {
        return Err(ProgramError::InvalidInstructionData);
    }
    let seed: [u8; 32] = data[0..32].try_into().unwrap();
    let interval = u64_at(data, 72);
    let remaining = u64_at(data, 80);
    let cu_limit = u32::from_le_bytes(data[96..100].try_into().unwrap());
    if cu_limit > MAX_CU_LIMIT || (remaining == 0 && interval == 0) {
        return Err(hydra_error(INVALID_SCHEDULE));
    }
    let (expected, bump) = Pubkey::find_program_address(&[b"crank", payer.key.as_ref(), &seed], &ID);
    if crank.key != &expected {
        return Err(ProgramError::InvalidSeeds);
    }
    let tail = region(data)?;
    let size = HEADER + tail.len();
    let rent_min = Rent::get()?.minimum_balance(size);
    let signer: &[&[u8]] = &[b"crank", payer.key.as_ref(), &seed, &[bump]];
    let prefunded = crank.lamports();
    if prefunded == 0 {
        invoke_signed(
            &create_account(payer.key, crank.key, rent_min, size as u64),
            &[payer.clone(), crank.clone(), system.clone()],
            &[signer],
        )?;
    } else {
        // Someone sent lamports to the address first: top it up, then allocate and assign.
        if rent_min > prefunded {
            invoke_signed(
                &system_call(2, &(rent_min - prefunded).to_le_bytes(), &[(payer.key, true), (crank.key, false)]),
                &[payer.clone(), crank.clone(), system.clone()],
                &[],
            )?;
        }
        invoke_signed(&system_call(8, &(size as u64).to_le_bytes(), &[(crank.key, true)]), &[crank.clone(), system.clone()], &[signer])?;
        invoke_signed(&system_call(1, ID.as_ref(), &[(crank.key, true)]), &[crank.clone(), system.clone()], &[signer])?;
    }
    let mut stored = crank.try_borrow_mut_data()?;
    stored[AUTHORITY..AUTHORITY + 32].copy_from_slice(&data[32..64]);
    stored[SEED..SEED + 32].copy_from_slice(&seed);
    stored[NEXT_EXEC..NEXT_EXEC + 8].copy_from_slice(&data[64..72]);
    put_u64(&mut stored, INTERVAL, interval);
    put_u64(&mut stored, REMAINING, if remaining == 0 { INFINITE } else { remaining });
    stored[TIP..TIP + 8].copy_from_slice(&data[88..96]);
    put_u64(&mut stored, EXECUTED, 0);
    put_u64(&mut stored, RENT_MIN, rent_min);
    stored[REGION_LEN..REGION_LEN + 2].copy_from_slice(&(tail.len() as u16).to_le_bytes());
    stored[BUMP] = bump;
    stored[CU_LIMIT..CU_LIMIT + 4].copy_from_slice(&cu_limit.to_le_bytes());
    stored[AUTHORITY_SIGNER] = (payer.key.as_ref() == &data[32..64]) as u8;
    stored[HEADER..].copy_from_slice(&tail);
    Ok(())
}

/// The system program's `CreateAccount`, owned by this program.
fn create_account(payer: &Pubkey, account: &Pubkey, lamports: u64, space: u64) -> Instruction {
    let mut data = 0u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(ID.as_ref());
    Instruction {
        program_id: Pubkey::default(),
        accounts: vec![AccountMeta::new(*payer, true), AccountMeta::new(*account, true)],
        data,
    }
}

/// A system program instruction: `Transfer` (2), `Allocate` (8) or `Assign` (1), with `(key, signer)`
/// accounts, all writable.
fn system_call(index: u32, args: &[u8], accounts: &[(&Pubkey, bool)]) -> Instruction {
    let mut data = index.to_le_bytes().to_vec();
    data.extend_from_slice(args);
    Instruction {
        program_id: Pubkey::default(),
        accounts: accounts.iter().map(|&(key, signer)| AccountMeta::new(*key, signer)).collect(),
        data,
    }
}

/// Accounts: `[crank(w), cranker(w,s), instructions_sysvar]`.
fn trigger(accounts: &[AccountInfo]) -> ProgramResult {
    let [crank, cranker, sysvar] = accounts_at::<3>(accounts)?;
    if get_stack_height() != TRANSACTION_LEVEL_STACK_HEIGHT {
        return Err(ProgramError::InvalidArgument);
    }
    if !cranker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if crank.owner != &ID {
        return Err(ProgramError::InvalidAccountOwner);
    }
    if sysvar.key != &solana_program::sysvar::instructions::ID {
        return Err(ProgramError::UnsupportedSysvar);
    }
    let mut stored = crank.try_borrow_mut_data()?;
    let slot = Clock::get()?.slot;
    if slot < u64_at(&stored, NEXT_EXEC) {
        return Err(hydra_error(NOT_YET_EXECUTABLE));
    }
    let remaining = u64_at(&stored, REMAINING);
    if remaining == 0 {
        return Err(hydra_error(EXHAUSTED));
    }
    let region_len = u16::from_le_bytes([stored[REGION_LEN], stored[REGION_LEN + 1]]) as usize;
    verify_followup(&sysvar.try_borrow_data()?, &stored[HEADER..HEADER + region_len])?;

    let reward = CRANKER_REWARD + u64_at(&stored, TIP);
    if crank.lamports() < u64_at(&stored, RENT_MIN) + reward {
        return Err(hydra_error(INSUFFICIENT_FUNDS));
    }
    **crank.try_borrow_mut_lamports()? -= reward;
    **cranker.try_borrow_mut_lamports()? += reward;
    let executed = u64_at(&stored, EXECUTED) + 1;
    put_u64(&mut stored, EXECUTED, executed);
    if remaining != INFINITE {
        put_u64(&mut stored, REMAINING, remaining - 1);
    }
    let next = u64_at(&stored, NEXT_EXEC).saturating_add(u64_at(&stored, INTERVAL));
    put_u64(&mut stored, NEXT_EXEC, next);
    Ok(())
}

/// The instruction after the current one must serialize to exactly the stored region.
fn verify_followup(sysvar: &[u8], tail: &[u8]) -> ProgramResult {
    if sysvar.len() < 4 {
        return Err(ProgramError::InvalidAccountData);
    }
    let current = u16::from_le_bytes([sysvar[sysvar.len() - 2], sysvar[sysvar.len() - 1]]) as usize;
    let target = current + 1;
    let count = u16::from_le_bytes([sysvar[0], sysvar[1]]) as usize;
    if target >= count {
        return Err(hydra_error(MISSING_FOLLOWUP));
    }
    let at = 2 + 2 * target;
    let start = u16::from_le_bytes([sysvar[at], sysvar[at + 1]]) as usize;
    let end = start + tail.len();
    if end > sysvar.len() - 2 || &sysvar[start..end] != tail {
        return Err(hydra_error(MISMATCHED_FOLLOWUP));
    }
    Ok(())
}

fn drain(from: &AccountInfo, to: &AccountInfo) -> ProgramResult {
    let amount = from.lamports();
    **from.try_borrow_mut_lamports()? = 0;
    **to.try_borrow_mut_lamports()? += amount;
    Ok(())
}

/// Accounts: `[authority(s), crank(w), recipient(w)]`.
fn cancel(accounts: &[AccountInfo]) -> ProgramResult {
    let [authority, crank, recipient] = accounts_at::<3>(accounts)?;
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if crank.owner != &ID {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let stored: [u8; 32] = crank.try_borrow_data()?[AUTHORITY..AUTHORITY + 32].try_into().unwrap();
    if stored == [0; 32] || authority.key.as_ref() != stored {
        return Err(hydra_error(UNAUTHORIZED));
    }
    drain(crank, recipient)
}

/// Accounts: `[reporter(s,w), crank(w), recipient(w)]`. Permissionless once the crank is exhausted,
/// underfunded or stale; the reporter gets one reward and the recipient, bound to the authority
/// when there is one, the rest.
fn close(accounts: &[AccountInfo]) -> ProgramResult {
    let [reporter, crank, recipient] = accounts_at::<3>(accounts)?;
    if !reporter.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if crank.owner != &ID {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let (authority, closable) = {
        let stored = crank.try_borrow_data()?;
        let authority: [u8; 32] = stored[AUTHORITY..AUTHORITY + 32].try_into().unwrap();
        let next_reward = CRANKER_REWARD + u64_at(&stored, TIP);
        let exhausted = u64_at(&stored, REMAINING) == 0;
        let underfunded = crank.lamports() < u64_at(&stored, RENT_MIN) + next_reward;
        let stale = Clock::get()?.slot.saturating_sub(u64_at(&stored, NEXT_EXEC)) > STALE_SLOTS;
        (authority, exhausted || underfunded || stale)
    };
    if !closable {
        return Err(hydra_error(NOT_CLOSABLE));
    }
    if authority != [0; 32] && recipient.key.as_ref() != authority {
        return Err(hydra_error(UNAUTHORIZED));
    }
    let balance = crank.lamports();
    let bounty = CRANKER_REWARD.min(balance);
    **crank.try_borrow_mut_lamports()? = 0;
    **reporter.try_borrow_mut_lamports()? += bounty;
    **recipient.try_borrow_mut_lamports()? += balance - bounty;
    Ok(())
}
