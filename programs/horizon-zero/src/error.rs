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
    #[msg("Account already exists")]
    AlreadyExists,
    #[msg("Battle has no VRF seed yet")]
    NotSeeded,
    #[msg("There is nothing to withdraw")]
    NothingToWithdraw,
    #[msg("Validator identity must be set")]
    BadValidator,
    #[msg("Only the program's upgrade authority may initialize")]
    NotUpgradeAuthority,
    #[msg("Battle cannot be cancelled before its wait is over")]
    TooEarly,
    #[msg("Battle is seeded: settle it instead")]
    AlreadySeeded,
}
