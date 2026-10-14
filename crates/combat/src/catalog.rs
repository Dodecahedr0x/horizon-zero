//! Unit stats and casts. The program copies a catalog row onto each army unit; `simulate` only
//! reads that copy.

use crate::{Aim, AshbornKind, BehaviorBody, DeeplingsKind, Effect, Race, RootbornKind};

/// One cast. It picks a target within `range` (ignored for [`Aim::Caster`]), then lands on
/// that target and on each unit of the same side within `aoe` tiles of it. Each one
/// takes `damage`, then the `effect` with `power`. `rounds` is how long a lasting
/// effect stays, counting the round it lands in. `cooldown` is how many rounds after the round
/// it fires the caster must wait before it can cast again; `0` lets it cast every round.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cast {
    pub damage: u8,
    pub range: u8,
    pub aoe: u8,
    pub effect: Effect,
    pub aim: Aim,
    pub power: u8,
    pub rounds: u8,
    pub cooldown: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnitStats {
    pub kind: u8,
    pub cost: u16,
    pub hp: i32,
    pub atk: i32,
    pub range: i32,
    pub speed: i32,
    /// Attacks or casts per turn. A point left unspent at the end of the turn becomes defense.
    pub actions: i32,
    pub cast: Cast,
}

/// A race the catalog knows. A second race is another arm, with its own kind match.
pub fn race_known(race: u8) -> bool {
    Race::from_u8(race).is_some()
}

/// Catalog lookup. This stays a `match`: an SBF build has returned the wrong
/// cost when the same table was a scanned const struct array.
pub fn stats_for(race: u8, kind: u8) -> Option<UnitStats> {
    match Race::from_u8(race)? {
        Race::Ashborn => Some(ashborn_stats(AshbornKind::from_u8(kind)?)),
        Race::Rootborn => Some(rootborn_stats(RootbornKind::from_u8(kind)?)),
        Race::Deeplings => Some(deeplings_stats(DeeplingsKind::from_u8(kind)?)),
    }
}

fn ashborn_stats(unit: AshbornKind) -> UnitStats {
    let kind = unit.id();
    match unit {
        AshbornKind::Guard => UnitStats {
            kind,
            cost: 2,
            hp: 14,
            atk: 8,
            range: 1,
            speed: 3,
            actions: 1,
            cast: Cast { damage: 9, range: 2, aoe: 0, effect: Effect::Push, aim: Aim::Foe, power: 1, rounds: 0, cooldown: 0 },
        },
        AshbornKind::Skirmisher => UnitStats {
            kind,
            cost: 2,
            hp: 10,
            atk: 12,
            range: 1,
            speed: 5,
            actions: 1,
            cast: Cast { damage: 0, range: 0, aoe: 0, effect: Effect::Sprint, aim: Aim::Caster, power: 1, rounds: 3, cooldown: 4 },
        },
        AshbornKind::Archer => UnitStats {
            kind,
            cost: 3,
            hp: 5,
            atk: 13,
            range: 3,
            speed: 3,
            actions: 1,
            cast: Cast { damage: 0, range: 0, aoe: 0, effect: Effect::Reach, aim: Aim::Caster, power: 2, rounds: 3, cooldown: 4 },
        },
        AshbornKind::Vanguard => UnitStats {
            kind,
            cost: 4,
            hp: 22,
            atk: 12,
            range: 1,
            speed: 4,
            actions: 1,
            cast: Cast { damage: 0, range: 2, aoe: 1, effect: Effect::Taunt, aim: Aim::Foe, power: 0, rounds: 3, cooldown: 4 },
        },
        AshbornKind::Warden => UnitStats {
            kind,
            cost: 5,
            hp: 17,
            atk: 12,
            range: 1,
            speed: 4,
            actions: 1,
            cast: Cast { damage: 0, range: 3, aoe: 0, effect: Effect::Heal, aim: Aim::Ally, power: 5, rounds: 0, cooldown: 0 },
        },
    }
}

fn rootborn_stats(unit: RootbornKind) -> UnitStats {
    let kind = unit.id();
    match unit {
        RootbornKind::Thornling => UnitStats {
            kind,
            cost: 4,
            hp: 24,
            atk: 17,
            range: 1,
            speed: 4,
            actions: 1,
            cast: Cast { damage: 6, range: 1, aoe: 1, effect: Effect::None, aim: Aim::Foe, power: 0, rounds: 0, cooldown: 3 },
        },
        RootbornKind::Briarsling => UnitStats {
            kind,
            cost: 7,
            hp: 23,
            atk: 14,
            range: 3,
            speed: 3,
            actions: 1,
            cast: Cast { damage: 12, range: 4, aoe: 0, effect: Effect::Push, aim: Aim::Foe, power: 1, rounds: 0, cooldown: 4 },
        },
        RootbornKind::Elderoak => UnitStats {
            kind,
            cost: 10,
            hp: 58,
            atk: 19,
            range: 1,
            speed: 2,
            actions: 1,
            cast: Cast { damage: 0, range: 3, aoe: 1, effect: Effect::Heal, aim: Aim::Ally, power: 5, rounds: 0, cooldown: 3 },
        },
    }
}

fn deeplings_stats(unit: DeeplingsKind) -> UnitStats {
    let kind = unit.id();
    match unit {
        DeeplingsKind::Clawling => UnitStats {
            kind,
            cost: 3,
            hp: 24,
            atk: 12,
            range: 1,
            speed: 3,
            actions: 1,
            cast: Cast { damage: 15, range: 1, aoe: 0, effect: Effect::None, aim: Aim::Foe, power: 0, rounds: 0, cooldown: 2 },
        },
        DeeplingsKind::Eelsnare => UnitStats {
            kind,
            cost: 4,
            hp: 19,
            atk: 12,
            range: 1,
            speed: 5,
            actions: 1,
            cast: Cast { damage: 0, range: 3, aoe: 0, effect: Effect::Taunt, aim: Aim::Foe, power: 0, rounds: 2, cooldown: 3 },
        },
        DeeplingsKind::Spineshot => UnitStats {
            kind,
            cost: 4,
            hp: 17,
            atk: 12,
            range: 3,
            speed: 3,
            actions: 1,
            cast: Cast { damage: 3, range: 3, aoe: 1, effect: Effect::None, aim: Aim::Foe, power: 0, rounds: 0, cooldown: 2 },
        },
        DeeplingsKind::Tidecaller => UnitStats {
            kind,
            cost: 6,
            hp: 20,
            atk: 9,
            range: 1,
            speed: 3,
            actions: 1,
            cast: Cast { damage: 9, range: 3, aoe: 1, effect: Effect::Push, aim: Aim::Foe, power: 2, rounds: 0, cooldown: 2 },
        },
    }
}

pub fn army_cost(race: u8, kinds: &[u8]) -> Option<u16> {
    let mut total: u16 = 0;
    for kind in kinds {
        let stats = stats_for(race, *kind)?;
        total = total.checked_add(stats.cost)?;
    }
    Some(total)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotUnit {
    pub kind: u8,
    pub behavior: BehaviorBody,
    /// Column inside the owner's starting zone.
    pub col: u8,
    /// `0` is the back row of the owner's zone. `1` is the inner row.
    pub row: u8,
    pub cost: u16,
    pub hp: i32,
    pub atk: i32,
    pub range: i32,
    pub speed: i32,
    pub actions: i32,
    pub cast: Cast,
}

impl SnapshotUnit {
    /// Copies one catalog row onto a snapshot. Combat itself does not call this.
    pub fn catalog(race: u8, kind: u8, behavior: BehaviorBody, col: u8, row: u8) -> Option<Self> {
        let stats = stats_for(race, kind)?;
        Some(Self { kind, behavior, col, row, cost: stats.cost, hp: stats.hp, atk: stats.atk, range: stats.range, speed: stats.speed, actions: stats.actions, cast: stats.cast })
    }
}
