//! Attacks and casts: who they hit and what they do.

use super::target::Pool;
use super::{Battle, Fighter, Status};
use crate::board::manhattan;
use crate::trace::TraceEvent;
use crate::{Aim, Cast, Effect, Element, TargetSpec, Verb, MAX_UNITS};

/// One unit a cast landed on, until its trace line is written.
#[derive(Clone, Copy, Default)]
struct Blow {
    index: usize,
    dealt: i32,
    hp: i32,
    amount: i32,
    from: (i32, i32),
}

/// True when landing the cast on this unit would change something. A cast never
/// picks a unit it would only waste itself on: full HP for a heal, or a status it
/// already carries.
fn cast_changes(cast: Cast, unit: &Fighter) -> bool {
    if cast.damage > 0 {
        return true;
    }
    match cast.effect {
        Effect::Heal => cast.power > 0 && unit.hp < unit.max_hp,
        effect if effect.lasts() => cast.rounds > 0 && unit.status(effect).is_none(),
        Effect::Push => cast.power > 0,
        _ => false,
    }
}

/// One orthogonal step that increases Manhattan distance from the caster.
/// The axis with the larger absolute delta wins. Column wins a tie.
fn away_delta(from: (i32, i32), caster: (i32, i32)) -> Option<(i32, i32)> {
    let dx = from.0 - caster.0;
    let dy = from.1 - caster.1;
    if dx == 0 && dy == 0 {
        return None;
    }
    if dx.abs() >= dy.abs() {
        Some((dx.signum(), 0))
    } else {
        Some((0, dy.signum()))
    }
}

impl Battle<'_> {
    /// Tries the element's actions in order while points remain. Returns whether one fired that
    /// counts for a movement's stop: a cast on the caster itself is a preparation, so it does not.
    pub(crate) fn try_actions(&mut self, actor: usize, element: &Element, action_points: &mut i32) -> bool {
        let mut fired = false;
        for action in element.actions.iter().take(element.action_len as usize) {
            if *action_points <= 0 {
                break;
            }
            self.charge(super::WORK_ACTION);
            fired |= match action.verb {
                Verb::Cast => self.try_cast(actor, action.target, action_points) && self.fighters[actor].cast.aim != Aim::Caster,
                Verb::Attack => self.try_attack(actor, action.target, action_points),
            };
        }
        fired
    }

    fn try_attack(&mut self, actor: usize, spec: TargetSpec, action_points: &mut i32) -> bool {
        let reach = self.fighters[actor].attack_range();
        let Some(target) = profiled!(self.profile, Choose, self.choose_target(actor, spec, Some(reach))) else {
            return false;
        };
        *action_points -= 1;
        let (dealt, hp) = self.apply_hit(target, self.fighters[actor].atk);
        let (side, index) = self.who(actor);
        let (target_side, target_index) = self.who(target);
        self.trace.push(TraceEvent::Attack { side, index, target_side, target_index, damage: dealt, target_hp: hp.max(0) });
        if hp <= 0 {
            self.trace.push(TraceEvent::Death { side: target_side, index: target_index });
        }
        true
    }

    pub(crate) fn try_cast(&mut self, actor: usize, spec: TargetSpec, action_points: &mut i32) -> bool {
        // Read the few fields used, not a copy of the whole fighter.
        let (cast, cast_ready, caster_at) = (self.fighters[actor].cast, self.fighters[actor].cast_ready, self.fighters[actor].tile());
        let (my_side, my_index) = self.who(actor);
        // Still cooling down from its last cast: the action does not fire and spends nothing.
        if self.round < cast_ready {
            return false;
        }
        let primary = match cast.aim {
            Aim::Caster => cast_changes(cast, &self.fighters[actor]).then_some(actor),
            aim => {
                let pool = match aim {
                    Aim::Foe => Pool { side: my_side.other(), with_self: false },
                    Aim::Ally => Pool { side: my_side, with_self: true },
                    _ => self.pool_for(actor, spec.side),
                };
                profiled!(self.profile, Choose, self.choose_from(actor, spec, pool, Some(cast.range as i32), |unit| { cast_changes(cast, unit) }))
            }
        };
        let Some(primary) = primary else {
            return false;
        };
        *action_points -= 1;
        self.fighters[actor].cast_ready = self.round + 1 + cast.cooldown as u32;

        // Fixed arrays: a cast lands on at most every fighter, and the program's heap never frees.
        let mut victims = [0usize; MAX_UNITS * 2];
        victims[0] = primary;
        let mut count = 1;
        if cast.aoe > 0 {
            let origin = self.fighters[primary].tile();
            let splash_side = self.fighters[primary].side;
            for (index, other) in self.fighters.iter().enumerate() {
                let splashed = index != primary && other.side == splash_side && other.alive() && cast_changes(cast, other) && manhattan(other.tile(), origin) <= cast.aoe as i32;
                if splashed && count < victims.len() {
                    victims[count] = index;
                    count += 1;
                }
            }
        }

        let mut blows = [Blow::default(); MAX_UNITS * 2];
        for (blow, &index) in blows.iter_mut().zip(&victims[..count]) {
            let from = self.fighters[index].tile();
            let (dealt, hp) = if cast.damage > 0 { self.apply_hit(index, cast.damage as i32) } else { (0, self.fighters[index].hp) };
            *blow = Blow { index, dealt, hp, amount: 0, from };
        }
        // Effects land after every hit, so a push cannot move a unit into a later splash.
        let blows = &mut blows[..count];
        for blow in blows.iter_mut() {
            if !self.fighters[blow.index].alive() {
                continue;
            }
            blow.amount = self.apply_effect(actor, blow.index, cast, caster_at);
            blow.hp = self.fighters[blow.index].hp;
        }
        if !self.trace.record {
            // The program keeps no trace; skip building the events it would drop.
            return true;
        }
        for blow in blows.iter() {
            let (target_side, target_index) = self.who(blow.index);
            let (to_col, to_row) = self.fighters[blow.index].tile();
            let lasting = cast.effect.lasts() && blow.hp > 0;
            self.trace.push(TraceEvent::Cast {
                side: my_side,
                index: my_index,
                target_side,
                target_index,
                damage: blow.dealt,
                target_hp: blow.hp.max(0),
                effect: cast.effect,
                amount: blow.amount,
                rounds: if lasting { cast.rounds } else { 0 },
                from_col: blow.from.0,
                from_row: blow.from.1,
                to_col,
                to_row,
            });
            if blow.hp <= 0 {
                self.trace.push(TraceEvent::Death { side: target_side, index: target_index });
            }
        }
        true
    }

    /// Lands one cast effect on a living unit and returns what it did, as the trace reports it.
    fn apply_effect(&mut self, caster: usize, index: usize, cast: Cast, caster_at: (i32, i32)) -> i32 {
        match cast.effect {
            Effect::Push => self.shove(index, caster_at, cast.power),
            Effect::Heal => {
                let unit = &mut self.fighters[index];
                let healed = (cast.power as i32).min(unit.max_hp - unit.hp).max(0);
                unit.hp += healed;
                healed
            }
            effect if effect.lasts() && cast.rounds > 0 => {
                self.fighters[index].add_status(Status { effect, power: cast.power, rounds: cast.rounds, source: caster as u8 });
                cast.power as i32
            }
            _ => 0,
        }
    }

    /// Damage after the target's defense, and the target's hp after it.
    fn apply_hit(&mut self, target: usize, amount: i32) -> (i32, i32) {
        let unit = &mut self.fighters[target];
        let dealt = (amount - unit.defense).max(0);
        let was_alive = unit.alive();
        unit.hp -= dealt;
        let (hp, alive, tile) = (unit.hp, unit.alive(), unit.tile());
        if was_alive && !alive {
            // A dead unit does not block its tile.
            self.occupancy_clear(tile);
        }
        (dealt, hp)
    }

    /// Pushes a unit up to `steps` tiles straight away from the caster. Returns how many it moved.
    pub(crate) fn shove(&mut self, index: usize, caster: (i32, i32), steps: u8) -> i32 {
        let mut moved = 0;
        for _ in 0..steps {
            let pos = self.fighters[index].tile();
            let Some((dc, dr)) = away_delta(pos, caster) else {
                break;
            };
            let next = (pos.0 + dc, pos.1 + dr);
            if self.field.is_blocked(next) || self.occupied(next) {
                break;
            }
            self.relocate(index, next);
            moved += 1;
        }
        moved
    }
}
