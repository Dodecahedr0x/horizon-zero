//! Deterministic auto-battle. No floats, no Solana types.
//! The program and the wasm replay both call [`simulate`] (the program through
//! [`simulate_winner`]), so both see the same winner and the same trace.
//!
//! - [`ids`]: every id as a byte enum
//! - [`behavior`]: the behavior body format and the standard bodies
//! - [`catalog`]: unit stats and casts
//! - [`board`]: geometry and rubble
//! - `engine`: the battle loop, targeting, movement, attacks and casts
//! - [`trace`]: the events a battle emits and their line format

/// Times `$body` as `$phase` on `$profile` when the `cu-profile` feature is on; otherwise it is
/// just `$body`.
macro_rules! profiled {
    ($profile:expr, $phase:ident, $body:expr) => {{
        #[cfg(feature = "cu-profile")]
        let start = crate::profile::now();
        let out = $body;
        #[cfg(feature = "cu-profile")]
        $profile.add(crate::profile::Phase::$phase, start);
        out
    }};
}

pub mod behavior;
pub mod board;
pub mod catalog;
mod engine;
pub mod ids;
#[cfg(feature = "cu-profile")]
mod profile;
#[cfg(test)]
mod tests;
pub mod trace;
#[cfg(feature = "wasm")]
mod wasm;

pub use behavior::*;
pub use board::{blocked_tiles, Geometry};
pub use catalog::*;
pub use engine::{simulate, simulate_winner, MAX_STATUSES};
pub use ids::*;
pub use trace::{trace_text, TraceEvent};

pub const ZONE_DEPTH: i32 = 2;
pub const MAX_COLS: i32 = 32;
pub const MAX_ROWS: i32 = 32;
pub const MAX_ROUNDS: u32 = 12;
pub const MAX_UNITS: usize = 10;

pub const MAX_ELEMENTS: usize = 4;
pub const MAX_ACTIONS: usize = 3;
/// `1 + 4 * (1 + 5 + 1 + 3 * 4)`.
pub const MAX_BEHAVIOR_LEN: usize = 77;

/// SHA-256 of the concatenated parts. On-chain this is the `sol_sha256` syscall; software
/// SHA-256 costs thousands of compute units per call. The program hashes through this too.
#[cfg(target_os = "solana")]
pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    solana_sha256_hasher::hashv(parts).to_bytes()
}

#[cfg(not(target_os = "solana"))]
pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// `SHA-256(seed || parts)`: every seeded order and tie-break.
pub(crate) fn mix(seed: &[u8; 32], parts: &[u8]) -> [u8; 32] {
    sha256(&[seed, parts])
}
