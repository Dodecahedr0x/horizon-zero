//! Picking a unit for a target rule, with a seeded tie-break.

use super::{Battle, Fighter};
use crate::board::manhattan;
use crate::{mix, Extremum, Side, Stat, TargetSide, TargetSpec};

/// Which units a target rule may pick from.
#[derive(Clone, Copy)]
pub(crate) struct Pool {
    pub(crate) side: Side,
    pub(crate) with_self: bool,
}

/// The best candidate so far by a primary key. A tie on the key falls back to a SHA-256 tie
/// key, smaller first. Tie keys are hashed only when two candidates actually tie: hashing
/// every candidate made a full battle cost several times the VRF callback's compute budget.
pub(crate) struct Best<T> {
    pub(crate) item: T,
    key: i32,
    tie: Option<[u8; 32]>,
}

pub(crate) fn consider<T: Copy>(best: &mut Option<Best<T>>, item: T, key: i32, higher: bool, tie_of: impl Fn(T) -> [u8; 32]) {
    let Some(current) = best else {
        *best = Some(Best { item, key, tie: None });
        return;
    };
    let better = if higher { key > current.key } else { key < current.key };
    if better {
        *best = Some(Best { item, key, tie: None });
    } else if key == current.key {
        let held = *current.tie.get_or_insert_with(|| tie_of(current.item));
        let tie = tie_of(item);
        if tie < held {
            *best = Some(Best { item, key, tie: Some(tie) });
        }
    }
}

impl Battle<'_> {
    /// The pool a behavior's target side names, seen from the actor. Never the actor itself.
    pub(crate) fn pool_for(&self, actor: usize, side: TargetSide) -> Pool {
        let me = self.fighters[actor].side;
        Pool { side: if side == TargetSide::Ally { me } else { me.other() }, with_self: false }
    }

    pub(crate) fn choose_target(&self, actor: usize, spec: TargetSpec, max_range: Option<i32>) -> Option<usize> {
        self.choose_from(actor, spec, self.pool_for(actor, spec.side), max_range, |_| true)
    }

    /// The unit in `pool` and in range that `spec` ranks first, skipping any `wanted` rejects.
    pub(crate) fn choose_from(&self, actor: usize, spec: TargetSpec, pool: Pool, max_range: Option<i32>, wanted: impl Fn(&Fighter) -> bool) -> Option<usize> {
        let me = &self.fighters[actor];
        self.charge(super::WORK_CANDIDATE * self.fighters.len() as u32);
        let tie_of = |idx: usize| {
            self.charge(super::WORK_HASH);
            let other = &self.fighters[idx];
            mix(&self.seed, &[me.side.id(), me.index, other.side.id(), other.index, self.round as u8])
        };
        let mut best = None;
        for (idx, unit) in self.fighters.iter().enumerate() {
            if (idx == actor && !pool.with_self) || unit.side != pool.side || !unit.alive() || !wanted(unit) {
                continue;
            }
            let distance = manhattan(me.tile(), unit.tile());
            if max_range.is_some_and(|reach| distance > reach) {
                continue;
            }
            let primary = match spec.stat {
                Stat::Hp => unit.hp,
                Stat::Atk => unit.atk,
                Stat::Distance => distance,
            };
            consider(&mut best, idx, primary, spec.extremum == Extremum::Highest, tie_of);
        }
        best.map(|found| found.item)
    }
}
