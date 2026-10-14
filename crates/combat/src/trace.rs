//! Trace events: one per thing that happens, and the line format clients replay.

use crate::{Effect, Side};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TraceEvent {
    Move {
        side: Side,
        index: u8,
        from_col: i32,
        from_row: i32,
        to_col: i32,
        to_row: i32,
    },
    Attack {
        side: Side,
        index: u8,
        target_side: Side,
        target_index: u8,
        damage: i32,
        target_hp: i32,
    },
    Cast {
        side: Side,
        index: u8,
        target_side: Side,
        target_index: u8,
        damage: i32,
        target_hp: i32,
        effect: Effect,
        /// What the effect did: tiles pushed, HP restored, or the status power.
        amount: i32,
        /// Rounds a lasting effect stays. `0` for an instant one.
        rounds: u8,
        from_col: i32,
        from_row: i32,
        to_col: i32,
        to_row: i32,
    },
    Defend {
        side: Side,
        index: u8,
    },
    Death {
        side: Side,
        index: u8,
    },
    /// A lasting effect ran out at the end of a round.
    Expire {
        side: Side,
        index: u8,
        effect: Effect,
    },
    /// A round that started has finished. The loop does not emit this for a round it never begins.
    Round,
    End {
        winner: Option<Side>,
        /// Both sides still had a living unit when [`crate::MAX_ROUNDS`] stopped the fight.
        limit: bool,
    },
}

impl TraceEvent {
    pub fn to_line(self) -> String {
        match self {
            TraceEvent::Move { side, index, from_col, from_row, to_col, to_row } => {
                format!("M {side} {index} {from_col} {from_row} {to_col} {to_row}")
            }
            TraceEvent::Attack { side, index, target_side, target_index, damage, target_hp } => {
                format!("A {side} {index} {target_side} {target_index} {damage} {target_hp}")
            }
            TraceEvent::Cast { side, index, target_side, target_index, damage, target_hp, effect, amount, rounds, from_col, from_row, to_col, to_row } => {
                format!("C {side} {index} {target_side} {target_index} {damage} {target_hp} {effect} {amount} {rounds} {from_col} {from_row} {to_col} {to_row}")
            }
            TraceEvent::Defend { side, index } => format!("F {side} {index}"),
            TraceEvent::Death { side, index } => format!("D {side} {index}"),
            TraceEvent::Expire { side, index, effect } => format!("X {side} {index} {effect}"),
            TraceEvent::Round => "R".to_string(),
            TraceEvent::End { winner: Some(side), .. } => format!("E {side}"),
            TraceEvent::End { winner: None, limit: true } => "E draw limit".to_string(),
            TraceEvent::End { winner: None, limit: false } => "E draw".to_string(),
        }
    }
}

pub fn trace_text(events: &[TraceEvent]) -> String {
    let mut out = String::new();
    for event in events {
        out.push_str(&event.to_line());
        out.push('\n');
    }
    out
}

/// Where the engine sends events. With `record` off, pushes are dropped and nothing is allocated.
pub(crate) struct Trace {
    pub(crate) record: bool,
    pub(crate) events: Vec<TraceEvent>,
}

impl Trace {
    pub(crate) fn recording() -> Self {
        Self { record: true, events: Vec::with_capacity(256) }
    }

    pub(crate) fn discarding() -> Self {
        Self { record: false, events: Vec::new() }
    }

    pub(crate) fn push(&mut self, event: TraceEvent) {
        if self.record {
            self.events.push(event);
        }
    }
}
