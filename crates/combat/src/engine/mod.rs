//! The battle loop: deployment, initiative, rounds, and each fighter's turn.

mod actions;
mod movement;
mod target;

use crate::board::{blocked_tiles, deploy, Field, Geometry};
use crate::trace::{Trace, TraceEvent};
use crate::{mix, BehaviorBody, Cast, Effect, Side, SnapshotUnit, Stop, MAX_ROUNDS, MAX_ROWS, MAX_UNITS, WORK_LIMIT};

/// Work charged per turn and per element in the actor's behavior, per step taken or tried, per
/// action tried, per fighter a target rule looks at, and per seeded tie-break hash. One unit is
/// about 14 compute units on chain; the weights come from a regression of `settle_match` cost.
/// See [`WORK_LIMIT`].
const WORK_TURN: u32 = 33;
const WORK_ELEMENT: u32 = 5;
const WORK_STEP: u32 = 60;
const WORK_ACTION: u32 = 18;
const WORK_CANDIDATE: u32 = 1;
const WORK_HASH: u32 = 14;

/// Lasting effects one unit can carry at once. One more replaces nothing and is dropped.
pub const MAX_STATUSES: usize = 4;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Fighter {
    pub(crate) side: Side,
    pub(crate) index: u8,
    pub(crate) col: i32,
    pub(crate) row: i32,
    pub(crate) hp: i32,
    pub(crate) atk: i32,
    pub(crate) range: i32,
    pub(crate) speed: i32,
    pub(crate) actions: i32,
    pub(crate) defense: i32,
    pub(crate) max_hp: i32,
    pub(crate) cast: Cast,
    pub(crate) behavior: BehaviorBody,
    pub(crate) statuses: [Status; MAX_STATUSES],
    /// The first round this fighter may cast in: the round after its last cast plus its cooldown.
    pub(crate) cast_ready: u32,
}

/// A lasting effect on a fighter. `rounds` 0 is an empty slot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Status {
    pub(crate) effect: Effect,
    pub(crate) power: u8,
    pub(crate) rounds: u8,
    /// Index into the fighter list of the unit that cast it.
    pub(crate) source: u8,
}

impl Fighter {
    fn spawn(side: Side, index: u8, (col, row): (i32, i32), unit: &SnapshotUnit) -> Self {
        // An invalid body plays as the empty sequence, so turns never re-check it.
        let behavior = if unit.behavior.is_valid() { unit.behavior } else { BehaviorBody::default() };
        Self {
            side,
            index,
            col,
            row,
            hp: unit.hp,
            atk: unit.atk,
            range: unit.range,
            speed: unit.speed,
            actions: unit.actions,
            defense: 0,
            max_hp: unit.hp,
            cast: unit.cast,
            behavior,
            statuses: [Status::default(); MAX_STATUSES],
            cast_ready: 0,
        }
    }

    pub(crate) fn tile(&self) -> (i32, i32) {
        (self.col, self.row)
    }

    pub(crate) fn alive(&self) -> bool {
        self.hp > 0
    }

    pub(crate) fn status(&self, effect: Effect) -> Option<Status> {
        self.statuses.iter().copied().find(|status| status.rounds > 0 && status.effect == effect)
    }

    /// Replaces a status of the same effect, else takes a free slot.
    pub(crate) fn add_status(&mut self, status: Status) {
        let slot = self.statuses.iter().position(|held| held.rounds > 0 && held.effect == status.effect).or_else(|| self.statuses.iter().position(|held| held.rounds == 0));
        if let Some(slot) = slot {
            self.statuses[slot] = status;
        }
    }

    pub(crate) fn movement_points(&self) -> i32 {
        let boost = self.status(Effect::Sprint).map_or(0, |status| status.power as i32);
        self.speed * (1 + boost)
    }

    pub(crate) fn attack_range(&self) -> i32 {
        self.range + self.status(Effect::Reach).map_or(0, |status| status.power as i32)
    }
}

/// Everything a turn reads or changes. Steps, targeting and casts are methods on it.
pub(crate) struct Battle<'t> {
    pub(crate) fighters: Vec<Fighter>,
    pub(crate) field: Field,
    pub(crate) seed: [u8; 32],
    pub(crate) round: u32,
    pub(crate) trace: &'t mut Trace,
    /// Tiles a living unit stands on, one bit mask per row (bit `col`). Kept in step with every
    /// move, push and death, so checking a tile is one lookup instead of a scan of the fighters.
    occupancy: [u32; MAX_ROWS as usize],
    #[cfg(feature = "cu-profile")]
    pub(crate) profile: crate::profile::Profile,
}

impl<'t> Battle<'t> {
    pub(crate) fn new(fighters: Vec<Fighter>, field: Field, seed: [u8; 32], trace: &'t mut Trace) -> Self {
        let mut occupancy = [0u32; MAX_ROWS as usize];
        for fighter in fighters.iter().filter(|fighter| fighter.alive()) {
            occupancy[fighter.row as usize] |= 1 << fighter.col;
        }
        Self {
            fighters,
            field,
            seed,
            round: 0,
            trace,
            occupancy,
            #[cfg(feature = "cu-profile")]
            profile: crate::profile::Profile::default(),
        }
    }
}

/// `winner` is `Some(Side::A)`, `Some(Side::B)`, or `None` for a draw.
/// The same value is the last trace event.
/// `col` and `row` on each snapshot are zone-local. The seed blocks tiles
/// between the zones and does not move the deployment.
pub fn simulate(side_a: &[SnapshotUnit], side_b: &[SnapshotUnit], seed: [u8; 32], board: Geometry) -> (Option<Side>, Vec<TraceEvent>) {
    let mut trace = Trace::recording();
    let (winner, _) = run(side_a, side_b, seed, board, &mut trace);
    (winner, trace.events)
}

/// The same battle as [`simulate`] without keeping the trace. The program calls this: its heap
/// is 32 KiB and never frees, so it must not hold hundreds of events it does not read.
pub fn simulate_winner(side_a: &[SnapshotUnit], side_b: &[SnapshotUnit], seed: [u8; 32], board: Geometry) -> Option<Side> {
    run(side_a, side_b, seed, board, &mut Trace::discarding()).0
}

/// The winner and the work the battle did, in [`WORK_LIMIT`]'s units. For tuning the limit.
pub fn simulate_work(side_a: &[SnapshotUnit], side_b: &[SnapshotUnit], seed: [u8; 32], board: Geometry) -> (Option<Side>, u32) {
    run(side_a, side_b, seed, board, &mut Trace::discarding())
}

fn run(side_a: &[SnapshotUnit], side_b: &[SnapshotUnit], seed: [u8; 32], board: Geometry, trace: &mut Trace) -> (Option<Side>, u32) {
    if !board.playable() {
        trace.push(TraceEvent::End { winner: None, limit: false, work: false });
        return (None, 0);
    }
    #[cfg(feature = "cu-profile")]
    let profile = crate::profile::Profile::default();
    let field = profiled!(profile, Rubble, Field::new(board, &blocked_tiles(board, &seed)));
    #[cfg(feature = "cu-profile")]
    let setup = crate::profile::now();
    let mut fighters = Vec::with_capacity(MAX_UNITS * 2);
    push_side(&mut fighters, Side::A, side_a, board);
    push_side(&mut fighters, Side::B, side_b, board);
    let mut battle = Battle::new(fighters, field, seed, trace);
    #[cfg(feature = "cu-profile")]
    battle.profile.absorb(&profile);

    // Initiative keys are hashed once, not once per comparison.
    let mut order: Vec<(usize, [u8; 32])> = battle.fighters.iter().enumerate().map(|(idx, fighter)| (idx, mix(&seed, &[fighter.side.id(), fighter.index]))).collect();
    order.sort_by(|left, right| {
        let a = &battle.fighters[left.0];
        let b = &battle.fighters[right.0];
        left.1.cmp(&right.1).then(a.side.cmp(&b.side)).then(a.index.cmp(&b.index))
    });
    #[cfg(feature = "cu-profile")]
    battle.profile.add(crate::profile::Phase::Setup, setup);

    for round in 0..MAX_ROUNDS {
        if battle.alive_count(Side::A) == 0 || battle.alive_count(Side::B) == 0 {
            break;
        }
        battle.round = round;
        for fighter in &mut battle.fighters {
            fighter.defense = 0;
        }
        for &(idx, _) in &order {
            if battle.exhausted() {
                break;
            }
            if !battle.fighters[idx].alive() {
                continue;
            }
            if battle.alive_count(battle.fighters[idx].side.other()) == 0 {
                break;
            }
            battle.act(idx);
        }
        if battle.exhausted() {
            break;
        }
        profiled!(battle.profile, Expire, battle.expire_statuses());
        battle.trace.push(TraceEvent::Round);
    }

    let a_alive = battle.alive_count(Side::A) > 0;
    let b_alive = battle.alive_count(Side::B) > 0;
    let winner = match (a_alive, b_alive) {
        (true, false) => Some(Side::A),
        (false, true) => Some(Side::B),
        // Out of work with both sides standing: the larger share of starting hp left wins. Ending
        // in a draw instead would let an army built to exhaust the meter turn a loss into a refund.
        (true, true) if battle.exhausted() => battle.healthier(),
        _ => None,
    };
    let work = a_alive && b_alive && battle.exhausted();
    let limit = a_alive && b_alive && !work;
    battle.trace.push(TraceEvent::End { winner, limit, work });
    #[cfg(feature = "cu-profile")]
    {
        battle.profile.absorb(&battle.field.profile_fill);
        battle.profile.log();
    }
    (winner, battle.field.work.get())
}

/// Deploys one side. A unit with no hp, outside its zone, or on an occupied tile is skipped.
pub(crate) fn push_side(fighters: &mut Vec<Fighter>, side: Side, units: &[SnapshotUnit], board: Geometry) {
    for (index, unit) in units.iter().take(MAX_UNITS).enumerate() {
        if unit.hp <= 0 {
            continue;
        }
        let Some(tile) = deploy(side, board, unit.col as i32, unit.row as i32) else {
            continue;
        };
        if fighters.iter().any(|fighter| fighter.alive() && fighter.tile() == tile) {
            continue;
        }
        fighters.push(Fighter::spawn(side, index as u8, tile, unit));
    }
}

impl Battle<'_> {
    /// A fighter's side and roster index, as trace events name it.
    pub(crate) fn who(&self, index: usize) -> (Side, u8) {
        (self.fighters[index].side, self.fighters[index].index)
    }

    /// Adds to the battle's work. See [`WORK_LIMIT`].
    pub(crate) fn charge(&self, units: u32) {
        self.field.charge(units);
    }

    pub(crate) fn exhausted(&self) -> bool {
        self.field.work.get() >= WORK_LIMIT
    }

    /// The side with the larger share of its starting hp still standing, or `None` on a tie.
    fn healthier(&self) -> Option<Side> {
        let share = |side: Side| {
            self.fighters
                .iter()
                .filter(|fighter| fighter.side == side)
                .fold((0i64, 0i64), |(left, start), fighter| (left + fighter.hp.max(0) as i64, start + fighter.max_hp as i64))
        };
        let ((a_left, a_start), (b_left, b_start)) = (share(Side::A), share(Side::B));
        match (a_left * b_start).cmp(&(b_left * a_start)) {
            core::cmp::Ordering::Greater => Some(Side::A),
            core::cmp::Ordering::Less => Some(Side::B),
            core::cmp::Ordering::Equal => None,
        }
    }

    pub(crate) fn alive_count(&self, side: Side) -> usize {
        self.fighters.iter().filter(|fighter| fighter.side == side && fighter.alive()).count()
    }

    /// True when a living unit stands on the tile. Callers ask about a tile other than the
    /// asking unit's own, so that unit never counts. Off-board tiles are never occupied.
    pub(crate) fn occupied(&self, (col, row): (i32, i32)) -> bool {
        (0..32).contains(&col) && (0..MAX_ROWS).contains(&row) && self.occupancy[row as usize] & (1 << col) != 0
    }

    pub(crate) fn occupancy_clear(&mut self, (col, row): (i32, i32)) {
        self.occupancy[row as usize] &= !(1 << col);
    }

    /// Moves a living unit to `to`, keeping the occupancy in step.
    pub(crate) fn relocate(&mut self, index: usize, to: (i32, i32)) {
        let unit = &mut self.fighters[index];
        self.occupancy[unit.row as usize] &= !(1 << unit.col);
        (unit.col, unit.row) = to;
        self.occupancy[to.1 as usize] |= 1 << to.0;
    }

    /// One fighter's turn: each element moves, then tries its actions, then a spare point defends.
    fn act(&mut self, actor: usize) {
        self.charge(WORK_TURN + WORK_ELEMENT * self.fighters[actor].behavior.len as u32);
        // Spent steps, not remaining ones: a sprint cast mid-turn raises the pool it is checked against.
        let mut moved = 0;
        let mut action_points = self.fighters[actor].actions;
        // One element at a time: copying the whole behavior each turn costs more than the loop.
        for slot in 0..self.fighters[actor].behavior.len as usize {
            if self.exhausted() {
                return;
            }
            let element = &self.fighters[actor].behavior.elements[slot].clone();
            let Some(movement) = element.movement else {
                profiled!(self.profile, Actions, self.try_actions(actor, element, &mut action_points));
                continue;
            };
            let mut step = 0;
            while moved < self.fighters[actor].movement_points() {
                if self.exhausted() {
                    return;
                }
                moved += 1;
                self.charge(WORK_STEP);
                let stepped = profiled!(self.profile, Move, self.take_step(actor, movement, step));
                let points = action_points;
                let fired = profiled!(self.profile, Actions, self.try_actions(actor, element, &mut action_points));
                step += 1;
                if fired && movement.stop == Stop::OnAction {
                    break;
                }
                // Nothing moved and nothing fired, so nothing changed: every later attempt in this
                // element would be the same no-op. Spend the points now instead of replaying them.
                if !stepped && points == action_points {
                    moved = moved.max(self.fighters[actor].movement_points());
                    break;
                }
            }
        }
        if action_points >= 1 {
            let me = &mut self.fighters[actor];
            me.defense = 1;
            let event = TraceEvent::Defend { side: me.side, index: me.index };
            self.trace.push(event);
        }
    }

    /// Counts down every status at the end of a round. Dead units keep theirs silently.
    fn expire_statuses(&mut self) {
        for fighter in &mut self.fighters {
            let alive = fighter.alive();
            for status in &mut fighter.statuses {
                if status.rounds == 0 {
                    continue;
                }
                status.rounds -= 1;
                if status.rounds == 0 && alive {
                    self.trace.push(TraceEvent::Expire { side: fighter.side, index: fighter.index, effect: status.effect });
                }
            }
        }
    }
}
