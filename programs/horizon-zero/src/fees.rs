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

const _: () = assert!(MAX_FEE_BPS <= 5_000);

pub fn win_payout(stake: u64, fee_bps: u16) -> WinPayout {
    let pot = stake as u128 * 2;
    let fee = (pot * fee_bps.min(MAX_FEE_BPS) as u128 / 10_000) as u64;
    // The cap keeps `fee <= stake`, so `pot - fee >= stake` and `pot - fee <= 2 * stake`. That
    // fits a u64 for every stake a Player can hold, which is far under `u64::MAX / 2`.
    let credit = pot - fee as u128;
    debug_assert!(credit <= u64::MAX as u128);
    WinPayout { fee, to_winner: stake - fee, credit: credit as u64 }
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
        let stake = u64::MAX / 2;
        let payout = win_payout(stake, MAX_FEE_BPS);
        assert!(payout.fee <= stake);
        assert_eq!(payout.to_winner + payout.fee, stake);
        assert_eq!(payout.credit as u128, 2 * stake as u128 - payout.fee as u128);
    }
}
