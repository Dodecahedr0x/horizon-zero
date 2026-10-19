//! Behavior bodies: the byte format players publish, and the ten standard bodies.

use crate::{sha256, Extremum, MoveKind, Stat, Stop, TargetSide, Verb, MAX_ACTIONS, MAX_BEHAVIOR_LEN, MAX_ELEMENTS};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TargetSpec {
    pub extremum: Extremum,
    pub stat: Stat,
    pub side: TargetSide,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Movement {
    pub kind: MoveKind,
    pub target: TargetSpec,
    pub stop: Stop,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Action {
    pub verb: Verb,
    pub target: TargetSpec,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Element {
    pub movement: Option<Movement>,
    pub actions: [Action; MAX_ACTIONS],
    pub action_len: u8,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BehaviorBody {
    pub elements: [Element; MAX_ELEMENTS],
    pub len: u8,
}

impl BehaviorBody {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.is_empty() || bytes.len() > MAX_BEHAVIOR_LEN {
            return None;
        }
        let mut index = 0;
        let count = *bytes.get(index)? as usize;
        index += 1;
        if count == 0 || count > MAX_ELEMENTS {
            return None;
        }
        let mut elements = [Element::default(); MAX_ELEMENTS];
        for slot in elements.iter_mut().take(count) {
            let present = *bytes.get(index)?;
            index += 1;
            if present > 1 {
                return None;
            }
            let movement = if present == 1 {
                let kind = MoveKind::from_u8(*bytes.get(index)?)?;
                let target = TargetSpec::parse(bytes.get(index + 1..index + 4)?)?;
                let stop = Stop::from_u8(*bytes.get(index + 4)?)?;
                index += 5;
                Some(Movement { kind, target, stop })
            } else {
                None
            };
            let action_len = *bytes.get(index)? as usize;
            index += 1;
            if action_len > MAX_ACTIONS {
                return None;
            }
            let mut actions = [Action::default(); MAX_ACTIONS];
            for action in actions.iter_mut().take(action_len) {
                let verb = Verb::from_u8(*bytes.get(index)?)?;
                let target = TargetSpec::parse(bytes.get(index + 1..index + 4)?)?;
                index += 4;
                *action = Action { verb, target };
            }
            *slot = Element { movement, actions, action_len: action_len as u8 };
        }
        if index != bytes.len() {
            return None;
        }
        Some(Self { elements, len: count as u8 })
    }

    pub fn canonical_bytes(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(MAX_BEHAVIOR_LEN);
        out.push(self.len);
        for element in self.elements.iter().take(self.len as usize) {
            if let Some(movement) = element.movement {
                out.push(1);
                out.push(movement.kind.id());
                out.extend_from_slice(&movement.target.bytes());
                out.push(movement.stop.id());
            } else {
                out.push(0);
            }
            out.push(element.action_len);
            for action in element.actions.iter().take(element.action_len as usize) {
                out.push(action.verb.id());
                out.extend_from_slice(&action.target.bytes());
            }
        }
        out
    }

    /// Whether `parse(canonical_bytes())` would accept this body, without allocating: the enums
    /// are typed, so the only bad states are the counts. The program's heap never frees.
    pub fn is_valid(self) -> bool {
        let len = self.len as usize;
        (1..=MAX_ELEMENTS).contains(&len) && self.elements[..len].iter().all(|element| element.action_len as usize <= MAX_ACTIONS)
    }
}

impl TargetSpec {
    /// Extremum, stat, side: three bytes, each a known id.
    fn parse(bytes: &[u8]) -> Option<Self> {
        Some(Self { extremum: Extremum::from_u8(bytes[0])?, stat: Stat::from_u8(bytes[1])?, side: TargetSide::from_u8(bytes[2])? })
    }

    fn bytes(self) -> [u8; 3] {
        [self.extremum.id(), self.stat.id(), self.side.id()]
    }
}

/// SHA-256 of the canonical body bytes. This is the behavior PDA seed.
pub fn behavior_hash(bytes: &[u8]) -> [u8; 32] {
    sha256(&[bytes])
}

pub fn behavior_march() -> BehaviorBody {
    BehaviorBody::parse(&[1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0]).unwrap()
}

pub fn behavior_charge() -> BehaviorBody {
    BehaviorBody::parse(&[1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]).unwrap()
}

pub fn behavior_kite() -> BehaviorBody {
    BehaviorBody::parse(&[2, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0]).unwrap()
}

pub fn behavior_flank_left() -> BehaviorBody {
    BehaviorBody::parse(&[1, 1, 2, 0, 0, 0, 0, 1, 0, 1, 2, 0]).unwrap()
}

pub fn behavior_flank_right() -> BehaviorBody {
    BehaviorBody::parse(&[1, 1, 3, 0, 0, 0, 0, 1, 0, 1, 2, 0]).unwrap()
}

pub fn behavior_march_cast() -> BehaviorBody {
    BehaviorBody::parse(&[1, 1, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0]).unwrap()
}

pub fn behavior_charge_cast() -> BehaviorBody {
    BehaviorBody::parse(&[1, 1, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0]).unwrap()
}

pub fn behavior_kite_cast() -> BehaviorBody {
    BehaviorBody::parse(&[2, 1, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0]).unwrap()
}

pub fn behavior_flank_left_cast() -> BehaviorBody {
    BehaviorBody::parse(&[1, 1, 2, 0, 0, 0, 0, 2, 1, 1, 2, 0, 0, 1, 2, 0]).unwrap()
}

pub fn behavior_flank_right_cast() -> BehaviorBody {
    BehaviorBody::parse(&[1, 1, 3, 0, 0, 0, 0, 2, 1, 1, 2, 0, 0, 1, 2, 0]).unwrap()
}
