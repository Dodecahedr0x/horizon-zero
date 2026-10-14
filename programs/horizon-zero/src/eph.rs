//! Ephemeral accounts: rollup-only accounts whose rent a sponsor pays (see `ephemeral_accounts`).
//! Under `inline-mock-magic` they are ordinary PDAs funded from the sponsor at Solana rent, so
//! LiteSVM exercises the same instruction paths.

use anchor_lang::prelude::*;

/// Lamports `create(space)` takes from the sponsor.
pub fn rent(space: usize) -> Result<u64> {
    #[cfg(feature = "inline-mock-magic")]
    {
        Ok(Rent::get()?.minimum_balance(space))
    }
    #[cfg(not(feature = "inline-mock-magic"))]
    {
        Ok(ephemeral_rollups_sdk::ephemeral_accounts::rent(space as u32))
    }
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
        use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed, system_instruction};
        let _ = (sponsor_seeds, vault);
        // The account may already hold lamports, so allocate and assign rather than create_account.
        let system = |ix: Instruction| invoke_signed(&ix, std::slice::from_ref(account), &[account_seeds]);
        system(system_instruction::allocate(account.key, space as u64))?;
        system(system_instruction::assign(account.key, &crate::ID))?;
        // After the CPIs: the runtime checks at a CPI that lamports moved only between the accounts
        // it is given, and the sponsor is not one of them.
        crate::move_lamports(sponsor, account, rent(space)?)?;
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
