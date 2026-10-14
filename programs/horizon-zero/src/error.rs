use anchor_lang::prelude::*;

#[error_code]
pub enum HorizonError {
    #[msg("Behavior body is not valid")]
    InvalidBehavior,
    #[msg("Behavior hash does not match the body")]
    HashMismatch,
    #[msg("Behavior account is missing or does not match the unit")]
    MissingBehavior,
    #[msg("Army cost exceeds the battleground budget")]
    BudgetExceeded,
    #[msg("An army can have at most 10 units")]
    TooManyUnits,
    #[msg("Race is not in the catalog")]
    BadRace,
    #[msg("Army cannot be changed in its current status")]
    BadStatus,
    #[msg("Battleground admin signature is required")]
    NotAdmin,
    #[msg("You cannot match your own army")]
    OwnArmy,
    #[msg("Account does not hold the stake")]
    NoStake,
    #[msg("Match is already resolved")]
    AlreadyResolved,
    #[msg("Account is not the expected PDA")]
    BadPda,
    #[msg("Signer does not own this army")]
    NotOwner,
    #[msg("Army is not in this battleground")]
    WrongBattleground,
    #[msg("Unit kind is not in the catalog")]
    BadUnit,
    #[msg("Battleground queue is full")]
    QueueFull,
    #[msg("A required account is missing")]
    MissingAccount,
    #[msg("Match account was not the next battleground match PDA")]
    BadMatch,
    #[msg("VRF request failed")]
    VrfRequest,
    #[msg("Oracle queue is not owned by the VRF program")]
    BadQueue,
    #[msg("Battleground grid is not playable")]
    BadGrid,
    #[msg("Unit position is outside the starting zone")]
    BadPosition,
    #[msg("Two units in one army cannot share a tile")]
    DuplicatePosition,
    #[msg("Settlement must directly follow the Hydra trigger for this battle's crank")]
    NotCranked,
    #[msg("Crank account is not this battle's Hydra crank")]
    BadCrank,
    #[msg("Pot budget does not cover the battleground stake")]
    PotTooLow,
    #[msg("Pot still has armies in unsettled battles")]
    PotBusy,
    #[msg("Pot holds less than the amount asked for")]
    PotShort,
}
