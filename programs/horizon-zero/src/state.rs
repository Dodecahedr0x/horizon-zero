use anchor_lang::prelude::*;
use horizon_combat::MAX_BEHAVIOR_LEN;

pub const MAX_UNITS: usize = 10;
pub const MAX_QUEUE: usize = 16;

// Each enum is one account byte. `use_discriminant` makes Borsh store the discriminant itself,
// so the bytes are the documented ids whatever the declaration order.

/// Where an army is in matchmaking.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
#[repr(u8)]
#[borsh(use_discriminant = true)]
pub enum ArmyStatus {
    #[default]
    Idle = 0,
    Queued = 1,
    Fighting = 2,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
#[repr(u8)]
#[borsh(use_discriminant = true)]
pub enum BattleStatus {
    /// Waiting for the VRF callback.
    #[default]
    Awaiting = 0,
    /// Settled and paid out.
    Resolved = 1,
    /// The VRF seed is stored; anyone may settle.
    Seeded = 2,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
#[repr(u8)]
#[borsh(use_discriminant = true)]
pub enum Outcome {
    /// Not resolved yet.
    #[default]
    Pending = 0,
    A = 1,
    B = 2,
    Draw = 3,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// The protocol fee on a won battle's pot, in basis points (see `fees`).
    pub fee_bps: u16,
    /// Claimable fee lamports, held on Config on top of its rent.
    pub fees: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Behavior {
    pub creator: Pubkey,
    pub len: u8,
    pub body: [u8; MAX_BEHAVIOR_LEN],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Battleground {
    pub admin: Pubkey,
    pub battleground_id: u8,
    pub budget: u16,
    pub stake_lamports: u64,
    pub cols: u8,
    pub rows: u8,
    /// Both zones are this many rows. Zone A is `0..zone_depth`. Zone B is the last `zone_depth` rows.
    pub zone_depth: u8,
    pub queue_len: u8,
    pub queue: [Pubkey; MAX_QUEUE],
    pub match_seq: u64,
    pub bump: u8,
}

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
    /// Off: payouts go back into `budget`. On: they go to `winnings`.
    pub segregate: bool,
    /// The owner's armies in battles that have not settled.
    pub fighting: u16,
    pub bump: u8,
}

impl Player {
    /// Adds a payout to the balance `segregate` picks.
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default)]
pub struct CastParams {
    pub damage: u8,
    pub range: u8,
    pub aoe: u8,
    pub effect: u8,
    pub aim: u8,
    pub power: u8,
    pub rounds: u8,
    pub cooldown: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct ArmyUnit {
    pub kind: u8,
    pub behavior: Pubkey,
    pub len: u8,
    pub body: [u8; MAX_BEHAVIOR_LEN],
    pub col: u8,
    pub row: u8,
    pub cost: u16,
    pub hp: u8,
    pub atk: u8,
    pub range: u8,
    pub speed: u8,
    pub cast: CastParams,
    /// Attacks or casts per turn. Stored after the cast so the cast offsets stay put.
    pub actions: u8,
}

impl Default for ArmyUnit {
    fn default() -> Self {
        Self {
            kind: 0,
            behavior: Pubkey::default(),
            len: 0,
            body: [0; MAX_BEHAVIOR_LEN],
            col: 0,
            row: 0,
            cost: 0,
            hp: 0,
            atk: 0,
            range: 0,
            speed: 0,
            cast: CastParams::default(),
            actions: 0,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Army {
    pub owner: Pubkey,
    pub battleground: Pubkey,
    pub race: u8,
    pub index: u32,
    pub unit_count: u8,
    pub units: [ArmyUnit; MAX_UNITS],
    pub status: ArmyStatus,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct SnapshotUnit {
    pub kind: u8,
    pub len: u8,
    pub body: [u8; MAX_BEHAVIOR_LEN],
    pub col: u8,
    pub row: u8,
    pub cost: u16,
    pub hp: u8,
    pub atk: u8,
    pub range: u8,
    pub speed: u8,
    pub cast: CastParams,
    /// Attacks or casts per turn. Stored after the cast so the cast offsets stay put.
    pub actions: u8,
}

impl Default for SnapshotUnit {
    fn default() -> Self {
        Self {
            kind: 0,
            len: 0,
            body: [0; MAX_BEHAVIOR_LEN],
            col: 0,
            row: 0,
            cost: 0,
            hp: 0,
            atk: 0,
            range: 0,
            speed: 0,
            cast: CastParams::default(),
            actions: 0,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Battle {
    pub battleground: Pubkey,
    pub army_a: Pubkey,
    pub army_b: Pubkey,
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    pub stake: u64,
    pub seq: u64,
    pub count_a: u8,
    pub count_b: u8,
    pub cols: u8,
    pub rows: u8,
    pub units_a: [SnapshotUnit; MAX_UNITS],
    pub units_b: [SnapshotUnit; MAX_UNITS],
    pub status: BattleStatus,
    pub seed: [u8; 32],
    pub outcome: Outcome,
    pub race_a: u8,
    pub race_b: u8,
    /// Config's fee rate when the battle opened; `settle_match` charges it.
    pub fee_bps: u16,
    pub bump: u8,
}

impl Battleground {
    pub fn queue_contains(&self, army: &Pubkey) -> bool {
        self.queue[..self.queue_len as usize].iter().any(|key| key == army)
    }

    pub fn enqueue(&mut self, army: Pubkey) -> Result<()> {
        require!((self.queue_len as usize) < MAX_QUEUE, crate::error::HorizonError::QueueFull);
        self.queue[self.queue_len as usize] = army;
        self.queue_len += 1;
        Ok(())
    }

    pub fn remove(&mut self, army: &Pubkey) {
        let len = self.queue_len as usize;
        if let Some(pos) = self.queue[..len].iter().position(|key| key == army) {
            self.queue[pos] = self.queue[len - 1];
            self.queue[len - 1] = Pubkey::default();
            self.queue_len -= 1;
        }
    }
}

#[cfg(test)]
mod layout_tests {
    use super::*;

    #[test]
    fn status_and_outcome_bytes_match_the_book() {
        let byte = |value: &dyn Fn(&mut Vec<u8>)| {
            let mut out = Vec::new();
            value(&mut out);
            out
        };
        assert_eq!(byte(&|out| ArmyStatus::Idle.serialize(out).unwrap()), [0]);
        assert_eq!(byte(&|out| ArmyStatus::Queued.serialize(out).unwrap()), [1]);
        assert_eq!(byte(&|out| ArmyStatus::Fighting.serialize(out).unwrap()), [2]);
        assert_eq!(byte(&|out| BattleStatus::Awaiting.serialize(out).unwrap()), [0]);
        assert_eq!(byte(&|out| BattleStatus::Resolved.serialize(out).unwrap()), [1]);
        assert_eq!(byte(&|out| BattleStatus::Seeded.serialize(out).unwrap()), [2]);
        assert_eq!(byte(&|out| Outcome::Pending.serialize(out).unwrap()), [0]);
        assert_eq!(byte(&|out| Outcome::A.serialize(out).unwrap()), [1]);
        assert_eq!(byte(&|out| Outcome::B.serialize(out).unwrap()), [2]);
        assert_eq!(byte(&|out| Outcome::Draw.serialize(out).unwrap()), [3]);
        assert!(ArmyStatus::deserialize(&mut &[3u8][..]).is_err(), "an unknown status byte does not load");
    }

    #[test]
    fn account_sizes_match_the_book() {
        assert_eq!(8 + Behavior::INIT_SPACE, 119);
        assert_eq!(8 + Battleground::INIT_SPACE, 576);
        assert_eq!(8 + Army::INIT_SPACE, 1360);
        assert_eq!(8 + Battle::INIT_SPACE, 2147); // + fee_bps 2
        assert_eq!(8 + Config::INIT_SPACE, 51); // admin 32, fee_bps 2, fees 8, bump 1
        assert_eq!(8 + Player::INIT_SPACE, 68); // owner 32, budget 8, winnings 8, locked 8, segregate 1, fighting 2, bump 1
        assert_eq!(8 + Outbox::INIT_SPACE, 49); // owner 32, amount 8, bump 1
    }

    #[test]
    fn free_is_what_the_counters_leave() {
        let player = Player {
            owner: Pubkey::default(),
            budget: 30,
            winnings: 5,
            locked: 10,
            segregate: false,
            fighting: 1,
            bump: 0,
        };
        assert_eq!(player.free(100, 20), 35);
        assert_eq!(player.free(40, 20), 0);
    }
}
