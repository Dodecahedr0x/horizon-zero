//! Test VRF program. Installed at the real VRF program id.
//! A scoped request whose accounts include the callback program, the scoped identity,
//! and the callback accounts invokes that callback immediately.
//! Randomness is the caller seed.

use solana_program::account_info::AccountInfo;
use solana_program::entrypoint::ProgramResult;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::program::invoke_signed;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

solana_program::declare_id!("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction<'a>(
    program_id: &Pubkey,
    accounts: &'a [AccountInfo<'a>],
    data: &[u8],
) -> ProgramResult {
    if program_id != &ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if data.first().copied() == Some(10) || data.first().copied() == Some(11) {
        // The runtime rejects a callback into the program that is already
        // executing lock. The request is accepted here; a following
        // instruction in the same transaction fulfills it.
        return Ok(());
    }
    if data.first().copied() != Some(12) {
        return Ok(());
    }
    let request = parse_request(&data[8..])?;
    if accounts.len() <= 5 {
        return Ok(());
    }
    let (scoped, bump) = Pubkey::find_program_address(
        &[b"identity", request.callback_program.as_ref()],
        program_id,
    );
    let callback_program = find_account(accounts, &request.callback_program)?;
    let scoped_ai = find_account(accounts, &scoped)?;
    let mut metas = vec![AccountMeta::new_readonly(scoped, true)];
    let mut infos = vec![callback_program.clone(), scoped_ai.clone()];
    for meta in &request.metas {
        let account = find_account(accounts, &meta.pubkey)?;
        metas.push(if meta.writable {
            AccountMeta::new(meta.pubkey, false)
        } else {
            AccountMeta::new_readonly(meta.pubkey, false)
        });
        infos.push(account.clone());
    }
    let mut callback_data = request.discriminator.clone();
    callback_data.extend_from_slice(&request.caller_seed);
    callback_data.extend_from_slice(&request.args);
    invoke_signed(
        &Instruction {
            program_id: request.callback_program,
            accounts: metas,
            data: callback_data,
        },
        &infos,
        &[&[b"identity", request.callback_program.as_ref(), &[bump]]],
    )
}

struct Meta {
    pubkey: Pubkey,
    writable: bool,
}

struct Request {
    caller_seed: [u8; 32],
    callback_program: Pubkey,
    discriminator: Vec<u8>,
    metas: Vec<Meta>,
    args: Vec<u8>,
}

fn parse_request(mut data: &[u8]) -> Result<Request, ProgramError> {
    if data.len() < 64 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut caller_seed = [0u8; 32];
    caller_seed.copy_from_slice(&data[..32]);
    data = &data[32..];
    let mut program_bytes = [0u8; 32];
    program_bytes.copy_from_slice(&data[..32]);
    data = &data[32..];
    let discriminator = read_vec(&mut data)?;
    let meta_count = read_u32(&mut data)? as usize;
    let mut metas = Vec::with_capacity(meta_count);
    for _ in 0..meta_count {
        if data.len() < 34 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&data[..32]);
        let writable = data[33] != 0;
        data = &data[34..];
        metas.push(Meta { pubkey: Pubkey::new_from_array(key), writable });
    }
    let args = read_vec(&mut data)?;
    Ok(Request {
        caller_seed,
        callback_program: Pubkey::new_from_array(program_bytes),
        discriminator,
        metas,
        args,
    })
}

fn read_u32(data: &mut &[u8]) -> Result<u32, ProgramError> {
    if data.len() < 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let value = u32::from_le_bytes(data[..4].try_into().unwrap());
    *data = &data[4..];
    Ok(value)
}

fn read_vec(data: &mut &[u8]) -> Result<Vec<u8>, ProgramError> {
    let len = read_u32(data)? as usize;
    if data.len() < len {
        return Err(ProgramError::InvalidInstructionData);
    }
    let out = data[..len].to_vec();
    *data = &data[len..];
    Ok(out)
}

fn find_account<'a>(accounts: &'a [AccountInfo<'a>], key: &Pubkey) -> Result<&'a AccountInfo<'a>, ProgramError> {
    accounts.iter().find(|account| account.key == key).ok_or(ProgramError::NotEnoughAccountKeys)
}
