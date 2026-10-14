//! One step of a movement: where the actor goes, if anywhere.

use super::target::consider;
use super::Battle;
use crate::board::{manhattan, Tiles, UNREACHABLE};
use crate::trace::TraceEvent;
use crate::{mix, Effect, MoveKind, Movement};

/// Next to the goal, no step gets closer: the only closer tile is the goal's own, which its unit
/// occupies. Checking this first skips the distance lookup for units already in contact.
fn adjacent(here: (i32, i32), goal: (i32, i32)) -> bool {
    manhattan(here, goal) <= 1
}

/// Distances to a goal from the actor's tile (`current`) and from each legal step.
struct Approach {
    current: i32,
    steps: [((i32, i32), i32); 4],
    count: usize,
}

impl Approach {
    fn steps(&self) -> &[((i32, i32), i32)] {
        &self.steps[..self.count]
    }
}

impl Battle<'_> {
    /// Moves the actor one tile when the movement finds one. Returns whether it moved.
    pub(crate) fn take_step(&mut self, actor: usize, movement: Movement, step: i32) -> bool {
        let Some(next) = self.pick_step(actor, movement, step) else {
            return false;
        };
        let (from_col, from_row) = self.fighters[actor].tile();
        if (from_col, from_row) == next {
            return false;
        }
        self.relocate(actor, next);
        let me = &self.fighters[actor];
        let event = TraceEvent::Move { side: me.side, index: me.index, from_col, from_row, to_col: next.0, to_row: next.1 };
        self.trace.push(event);
        true
    }

    fn pick_step(&self, actor: usize, movement: Movement, step: i32) -> Option<(i32, i32)> {
        // A living taunter overrides the behavior: walk toward it.
        let taunter = self.fighters[actor].status(Effect::Taunt).map(|status| status.source as usize).filter(|&source| self.fighters.get(source).is_some_and(|unit| unit.alive()));
        if let Some(source) = taunter {
            return self.step_toward(actor, self.fighters[source].tile(), step);
        }
        let target = profiled!(self.profile, Target, self.choose_target(actor, movement.target, None))?;
        let goal = self.fighters[target].tile();
        match movement.kind {
            MoveKind::Approach => self.step_toward(actor, goal, step),
            MoveKind::Flee => self.step_away(actor, goal, step),
            MoveKind::FlankLeft => self.step_flank(actor, goal, true, step),
            MoveKind::FlankRight => self.step_flank(actor, goal, false, step),
        }
    }

    /// Up to four legal orthogonal steps, in a fixed order.
    fn candidates(&self, actor: usize) -> Tiles {
        let (col, row) = self.fighters[actor].tile();
        let mut out = Tiles::default();
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let tile = (col + dx, row + dy);
            if !self.field.is_blocked(tile) && !self.occupied(tile) {
                out.push(tile);
            }
        }
        out
    }

    fn tie_key(&self, actor: usize, step: i32, (col, row): (i32, i32)) -> [u8; 32] {
        let me = &self.fighters[actor];
        mix(&self.seed, &[me.side.id(), me.index, self.round as u8, step as u8, col as u8, row as u8])
    }

    /// Distance to `goal` from the actor's tile and from each legal step, for choosing a step:
    /// walking distance around rubble, or straight-line distance when the goal cannot be walked to.
    fn approach_distances(&self, actor: usize, goal: (i32, i32), legal: &Tiles) -> Approach {
        let here = self.fighters[actor].tile();
        let steps = legal.as_slice();
        let mut asked = [here; 5];
        asked[1..=steps.len()].copy_from_slice(steps);
        let walked = profiled!(self.profile, Path, self.field.walking_distances(goal, asked));
        let reachable = walked[0] != UNREACHABLE;
        let distance = |slot: usize, tile| {
            if reachable {
                walked[slot] as i32
            } else {
                manhattan(tile, goal)
            }
        };
        let mut out = Approach { current: distance(0, here), steps: [(here, 0); 4], count: steps.len() };
        for (slot, &tile) in steps.iter().enumerate() {
            out.steps[slot] = (tile, distance(slot + 1, tile));
        }
        out
    }

    /// The legal step that most reduces the distance to `goal`.
    fn step_toward(&self, actor: usize, goal: (i32, i32), step: i32) -> Option<(i32, i32)> {
        if adjacent(self.fighters[actor].tile(), goal) {
            return None;
        }
        let approach = self.approach_distances(actor, goal, &self.candidates(actor));
        let mut best = None;
        for &(tile, closer) in approach.steps() {
            if closer < approach.current {
                consider(&mut best, tile, closer, false, |tile| self.tie_key(actor, step, tile));
            }
        }
        best.map(|found| found.item)
    }

    /// The legal step that most increases distance from `threat`.
    fn step_away(&self, actor: usize, threat: (i32, i32), step: i32) -> Option<(i32, i32)> {
        let current = manhattan(self.fighters[actor].tile(), threat);
        let mut best = None;
        for &tile in self.candidates(actor).as_slice() {
            let distance = manhattan(tile, threat);
            if distance > current {
                consider(&mut best, tile, distance, true, |tile| self.tie_key(actor, step, tile));
            }
        }
        best.map(|found| found.item)
    }

    /// Closes in on `goal` from one side. With the goal straight ahead and more than two tiles
    /// away, the actor first steps sideways toward its flank; otherwise it takes the step that gets
    /// closer and lies furthest toward that flank. Every step but the sidestep gets closer, and a
    /// sidestep leaves the goal off-line, so a flanker always arrives instead of circling.
    fn step_flank(&self, actor: usize, goal: (i32, i32), left: bool, step: i32) -> Option<(i32, i32)> {
        let here = self.fighters[actor].tile();
        if adjacent(here, goal) {
            return None;
        }
        let (dx, dy) = (goal.0 - here.0, goal.1 - here.1);
        // The flank side of the line toward the goal: `(dc, dr)` turned left is `(dr, -dc)`.
        let side = if left { (dy, -dx) } else { (-dy, dx) };
        let legal = self.candidates(actor);
        let approach = self.approach_distances(actor, goal, &legal);
        if (dx == 0 || dy == 0) && approach.current > 2 {
            let sidestep = (here.0 + side.0.signum(), here.1 + side.1.signum());
            if legal.contains(&sidestep) {
                return Some(sidestep);
            }
        }
        let mut best = None;
        for &(tile, closer) in approach.steps() {
            if closer < approach.current {
                let lateral = (tile.0 - here.0) * side.0 + (tile.1 - here.1) * side.1;
                consider(&mut best, tile, lateral, true, |tile| self.tie_key(actor, step, tile));
            }
        }
        best.map(|found| found.item)
    }
}
