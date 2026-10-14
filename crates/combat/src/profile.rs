//! On-chain compute profile, for tuning only (feature `cu-profile`). Each probe reads the
//! remaining compute units, so a phase's cost is the drop across it; the totals are logged once
//! at the end of a battle with `sol_log_64_` as `PROFILE_TAG, phase, units, calls, 0`. Without
//! the feature the macro is the bare expression and nothing here is compiled in.

/// Phases, in log order. Nested phases are inside an outer one: `Target` and `Path` are part of
/// `Move`; `Choose` is part of `Actions`; `Fill` is part of `Path`.
#[derive(Clone, Copy)]
pub(crate) enum Phase {
    Rubble = 0,
    Setup = 1,
    Move = 2,
    Target = 3,
    Path = 4,
    Actions = 5,
    Choose = 6,
    Expire = 7,
    /// Growing a walking-distance wave by one step, inside `Path`.
    Fill = 8,
}

use core::cell::Cell;

pub(crate) const PHASES: usize = 9;
pub const PROFILE_TAG: u64 = 0xC0FFEE;

/// Cells, so probes inside `&self` methods can record.
#[derive(Default)]
pub(crate) struct Profile {
    units: [Cell<u64>; PHASES],
    calls: [Cell<u64>; PHASES],
}

impl Profile {
    pub(crate) fn add(&self, phase: Phase, start: u64) {
        let at = phase as usize;
        self.units[at].set(self.units[at].get() + start.saturating_sub(now()));
        self.calls[at].set(self.calls[at].get() + 1);
    }

    /// Adds another profile's totals into this one.
    pub(crate) fn absorb(&self, other: &Profile) {
        for at in 0..PHASES {
            self.units[at].set(self.units[at].get() + other.units[at].get());
            self.calls[at].set(self.calls[at].get() + other.calls[at].get());
        }
    }

    pub(crate) fn log(&self) {
        for phase in 0..PHASES {
            log5(PROFILE_TAG, phase as u64, self.units[phase].get(), self.calls[phase].get(), 0);
        }
    }
}

#[cfg(target_os = "solana")]
pub(crate) fn now() -> u64 {
    extern "C" {
        fn sol_remaining_compute_units() -> u64;
    }
    unsafe { sol_remaining_compute_units() }
}

#[cfg(not(target_os = "solana"))]
pub(crate) fn now() -> u64 {
    0
}

#[cfg(target_os = "solana")]
fn log5(a: u64, b: u64, c: u64, d: u64, e: u64) {
    extern "C" {
        fn sol_log_64_(a: u64, b: u64, c: u64, d: u64, e: u64);
    }
    unsafe { sol_log_64_(a, b, c, d, e) }
}

#[cfg(not(target_os = "solana"))]
fn log5(_: u64, _: u64, _: u64, _: u64, _: u64) {}
