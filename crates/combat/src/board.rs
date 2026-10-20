//! The grid: geometry, the rubble a seed places, and tile lookups during a battle.

use crate::{mix, Side, MAX_COLS, MAX_ROWS, MAX_TILES, ZONE_DEPTH};
use core::cell::{Cell, RefCell};

/// Columns and rows of one battleground. Starting zones are the top and bottom
/// `ZONE_DEPTH` rows and are not stored separately.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    pub cols: i32,
    pub rows: i32,
}

impl Geometry {
    /// At least one column and both zones, within the column, row and tile caps that keep a full
    /// settle inside the program's heap and compute budget.
    pub fn playable(self) -> bool {
        self.cols >= 1 && self.rows >= ZONE_DEPTH * 2 && self.cols <= MAX_COLS && self.rows <= MAX_ROWS && self.cols * self.rows <= MAX_TILES
    }

    pub fn non_zone_tiles(self) -> i32 {
        if !self.playable() {
            return 0;
        }
        self.cols * (self.rows - ZONE_DEPTH * 2)
    }
}

/// Tiles the seed blocks. Starting-zone tiles are never included.
/// Candidates are the non-zone cells, ordered by `SHA-256(seed || [col, row])`,
/// then row, then column. Each candidate is blocked when the open grid still
/// connects zone A to zone B and the blocked count is still under
/// `non_zone_tiles / 5`.
pub fn blocked_tiles(board: Geometry, seed: &[u8; 32]) -> Vec<(i32, i32)> {
    if !board.playable() {
        return Vec::new();
    }
    let mut candidates = Vec::with_capacity(board.non_zone_tiles() as usize);
    for row in ZONE_DEPTH..(board.rows - ZONE_DEPTH) {
        for col in 0..board.cols {
            candidates.push((mix(seed, &[col as u8, row as u8]), col, row));
        }
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0).then(left.2.cmp(&right.2)).then(left.1.cmp(&right.1)));
    let cap = (board.non_zone_tiles() / 5) as usize;
    let mut blocked = Vec::with_capacity(cap + 1);
    // One flood-fill buffer for every candidate: the program's heap never frees.
    let mut fill = Fill::new(board);
    for (_, col, row) in candidates {
        if blocked.len() >= cap {
            break;
        }
        let at = (row * board.cols + col) as usize;
        fill.blocked[at] = true;
        if zones_connected(board, &mut fill) {
            blocked.push((col, row));
        } else {
            fill.blocked[at] = false;
        }
    }
    blocked.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
    blocked
}

/// Flood-fill buffers, reused for every candidate. `blocked` is a grid, so a neighbour check is
/// one lookup instead of a scan of the blocked list: the scan made placing rubble on Citadel cost
/// several hundred thousand compute units.
pub(crate) struct Fill {
    pub(crate) blocked: Vec<bool>,
    seen: Vec<bool>,
    stack: Vec<(i32, i32)>,
}

impl Fill {
    pub(crate) fn new(board: Geometry) -> Self {
        let tiles = (board.cols * board.rows) as usize;
        Self { blocked: vec![false; tiles], seen: vec![false; tiles], stack: Vec::with_capacity(tiles) }
    }
}

pub(crate) fn zones_connected(board: Geometry, fill: &mut Fill) -> bool {
    fill.seen.copy_from_slice(&fill.blocked);
    fill.stack.clear();
    fill.stack.push((0, 0));
    let index = |col: i32, row: i32| (row * board.cols + col) as usize;
    fill.seen[0] = true;
    while let Some((col, row)) = fill.stack.pop() {
        if row >= board.rows - ZONE_DEPTH {
            return true;
        }
        for (dc, dr) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let next_col = col + dc;
            let next_row = row + dr;
            if next_col < 0 || next_row < 0 || next_col >= board.cols || next_row >= board.rows {
                continue;
            }
            let at = index(next_col, next_row);
            if fill.seen[at] {
                continue;
            }
            fill.seen[at] = true;
            fill.stack.push((next_col, next_row));
        }
    }
    false
}

/// A battle's board: bounds, one blocked flag per tile (row-major), and each row's open tiles as
/// a bit mask (bit `col`), which the walking-distance search expands a whole row at a time.
pub(crate) struct Field {
    cols: i32,
    rows: i32,
    blocked: Vec<bool>,
    open: Vec<u32>,
    walks: RefCell<Walks>,
    /// The battle's work so far, in the units [`crate::WORK_LIMIT`] counts (see `Battle::charge`).
    /// Here because the walks charge it from `&self` methods.
    pub(crate) work: Cell<u32>,
    #[cfg(feature = "cu-profile")]
    pub(crate) profile_fill: crate::profile::Profile,
}

/// Waves kept per goal tile, oldest replaced first.
const WALK_SLOTS: usize = 8;

/// Waves on the heap: eight of them would crowd the program's 4 KiB stack frame.
struct Walks {
    slots: Vec<Walk>,
    next: usize,
    last: usize,
}

impl Default for Walks {
    fn default() -> Self {
        Self { slots: (0..WALK_SLOTS).map(|_| Walk::default()).collect(), next: 0, last: 0 }
    }
}

/// One goal's wave: the distance of every tile reached so far, the tiles reached (`seen`), the
/// current frontier and the rows it spans.
#[derive(Default)]
struct Walk {
    goal: Option<(i32, i32)>,
    steps: Vec<u16>,
    seen: [u32; MAX_ROWS as usize],
    /// Two frontier buffers; `current` is the one holding the latest wave.
    waves: [[u32; MAX_ROWS as usize]; 2],
    current: usize,
    lo: usize,
    hi: usize,
    distance: u16,
    done: bool,
}

/// Work charged per walking-distance question, per wave started (clearing its distances), and per
/// row one step of a wave scans. See [`crate::WORK_LIMIT`].
const WORK_WALK: u32 = 44;
const WORK_START_WALK: u32 = 64;
const WORK_WAVE_ROW: u32 = 8;

/// Walking distance of a tile the goal cannot be reached from.
pub(crate) const UNREACHABLE: u16 = u16::MAX;

impl Field {
    pub(crate) fn new(board: Geometry, blocked: &[(i32, i32)]) -> Self {
        let mut grid = vec![false; (board.cols * board.rows) as usize];
        for &(col, row) in blocked {
            grid[(row * board.cols + col) as usize] = true;
        }
        let full = if board.cols >= 32 { u32::MAX } else { (1u32 << board.cols) - 1 };
        let open = (0..board.rows).map(|row| (0..board.cols).filter(|&col| grid[(row * board.cols + col) as usize]).fold(full, |mask, col| mask & !(1 << col))).collect();
        Self {
            cols: board.cols,
            rows: board.rows,
            blocked: grid,
            open,
            walks: RefCell::default(),
            work: Cell::new(0),
            #[cfg(feature = "cu-profile")]
            profile_fill: crate::profile::Profile::default(),
        }
    }

    /// Orthogonal steps from each of `tiles` to `goal` over tiles that are not rubble, or
    /// [`UNREACHABLE`]. Living units are not walls: they move, and an ally in the way is stepped
    /// around tile by tile. Rubble never moves either, so each goal keeps one wave that grows from
    /// it, one bit mask per row, only as far as the tiles asked for so far; a later question about
    /// the same goal continues the same wave. An actor's goal stays put through its turn, and
    /// allies often share one.
    pub(crate) fn walking_distances<const N: usize>(&self, goal: (i32, i32), tiles: [(i32, i32); N]) -> [u16; N] {
        let mut out = [UNREACHABLE; N];
        self.charge(WORK_WALK);
        if self.is_blocked(goal) {
            return out;
        }
        let mut walks = self.walks.borrow_mut();
        // An actor's next step usually asks about the same goal, so try the last slot first.
        let last = walks.last;
        let found = if walks.slots[last].goal == Some(goal) { Some(last) } else { walks.slots.iter().position(|walk| walk.goal == Some(goal)) };
        let slot = match found {
            Some(slot) => slot,
            None => {
                // Replace the oldest wave. Buffers are allocated once: the program's heap never frees.
                let slot = walks.next;
                walks.next = (slot + 1) % WALK_SLOTS;
                self.start_walk(&mut walks.slots[slot], goal);
                slot
            }
        };
        walks.last = slot;
        let walk = &mut walks.slots[slot];
        for (distance, &tile) in out.iter_mut().zip(&tiles) {
            if self.is_blocked(tile) {
                continue;
            }
            let at = (tile.1 * self.cols + tile.0) as usize;
            debug_assert!(at < walk.steps.len());
            // SAFETY: `tile` is on the board (`is_blocked` checked it), so `at < cols * rows`, the
            // length of `steps`.
            while unsafe { *walk.steps.get_unchecked(at) } == UNREACHABLE && !walk.done {
                #[cfg(feature = "cu-profile")]
                let start = crate::profile::now();
                self.grow_walk(walk);
                #[cfg(feature = "cu-profile")]
                self.profile_fill.add(crate::profile::Phase::Fill, start);
            }
            // SAFETY: as above.
            *distance = unsafe { *walk.steps.get_unchecked(at) };
        }
        out
    }

    fn start_walk(&self, walk: &mut Walk, goal: (i32, i32)) {
        let tiles = (self.cols * self.rows) as usize;
        self.charge(WORK_START_WALK);
        if walk.steps.len() != tiles {
            walk.steps = vec![UNREACHABLE; tiles];
        } else {
            walk.steps.fill(UNREACHABLE);
        }
        let row = goal.1 as usize;
        walk.goal = Some(goal);
        walk.seen = [0; MAX_ROWS as usize];
        walk.current = 0;
        walk.seen[row] = 1 << goal.0;
        walk.waves[0][row] = 1 << goal.0;
        walk.steps[row * self.cols as usize + goal.0 as usize] = 0;
        (walk.lo, walk.hi, walk.distance, walk.done) = (row, row, 0, false);
    }

    /// Grows the wave one step and records the distance of every tile it newly reaches. The new
    /// frontier is written straight into the other buffer, over the rows it can reach; rows outside
    /// `lo..=hi` are never read, so neither buffer is cleared.
    fn grow_walk(&self, walk: &mut Walk) {
        let (lo, hi) = (walk.lo, walk.hi);
        let (next_lo, next_hi) = (lo.saturating_sub(1), (hi + 1).min(self.rows as usize - 1));
        self.charge(WORK_WAVE_ROW * (next_hi - next_lo + 1) as u32);
        let [first, second] = &mut walk.waves;
        let (from, to) = if walk.current == 0 { (&*first, second) } else { (&*second, first) };
        let cols = self.cols as usize;
        let (mut grown_lo, mut grown_hi) = (usize::MAX, 0);
        debug_assert!(next_hi < self.rows as usize && self.open.len() == self.rows as usize);
        debug_assert!(walk.steps.len() == (self.cols * self.rows) as usize);
        for row in next_lo..=next_hi {
            // SAFETY: `row <= next_hi < rows <= MAX_ROWS`, the length of `from`, `to` and `seen`
            // and at most the length of `open` (`rows`); `row - 1` and `row + 1` are read only
            // inside `lo..=hi`, which is within `0..rows`. Each bit of `reach` is a bit of
            // `open[row]`, whose bits are below `cols`, so `row * cols + col < rows * cols`, the
            // length of `steps`. This loop is the hottest code on chain; bounds checks were most
            // of its cost.
            unsafe {
                let here = if row >= lo && row <= hi { *from.get_unchecked(row) } else { 0 };
                let up = if row > lo && row - 1 <= hi { *from.get_unchecked(row - 1) } else { 0 };
                let down = if row + 1 >= lo && row < hi { *from.get_unchecked(row + 1) } else { 0 };
                let seen = walk.seen.get_unchecked_mut(row);
                let reach = ((here << 1) | (here >> 1) | up | down) & *self.open.get_unchecked(row) & !*seen;
                *to.get_unchecked_mut(row) = reach;
                if reach != 0 {
                    *seen |= reach;
                    grown_lo = grown_lo.min(row);
                    grown_hi = row;
                    let base = row * cols;
                    let mut bits = reach;
                    while bits != 0 {
                        *walk.steps.get_unchecked_mut(base + bits.trailing_zeros() as usize) = walk.distance + 1;
                        bits &= bits - 1;
                    }
                }
            }
        }
        if grown_lo == usize::MAX {
            walk.done = true;
            return;
        }
        walk.distance += 1;
        walk.current ^= 1;
        (walk.lo, walk.hi) = (grown_lo, grown_hi);
    }

    pub(crate) fn charge(&self, units: u32) {
        self.work.set(self.work.get().saturating_add(units));
    }

    /// Off-board tiles count as blocked.
    pub(crate) fn is_blocked(&self, (col, row): (i32, i32)) -> bool {
        if !(col >= 0 && col < self.cols && row >= 0 && row < self.rows) {
            return true;
        }
        // SAFETY: the tile is on the board, so the index is below `cols * rows`, the grid's length.
        unsafe { *self.blocked.get_unchecked((row * self.cols + col) as usize) }
    }
}

/// A small fixed set of tiles, at most four. No heap: this is built for every step.
#[derive(Clone, Copy, Default)]
pub(crate) struct Tiles {
    items: [(i32, i32); 4],
    len: usize,
}

impl Tiles {
    pub(crate) fn push(&mut self, tile: (i32, i32)) {
        if self.len < self.items.len() {
            self.items[self.len] = tile;
            self.len += 1;
        }
    }

    pub(crate) fn as_slice(&self) -> &[(i32, i32)] {
        &self.items[..self.len]
    }

    pub(crate) fn contains(&self, tile: &(i32, i32)) -> bool {
        self.as_slice().contains(tile)
    }
}

/// Board tile of a zone-local position, or `None` outside the owner's zone.
pub(crate) fn deploy(side: Side, board: Geometry, col: i32, row: i32) -> Option<(i32, i32)> {
    if col < 0 || row < 0 || col >= board.cols || row >= ZONE_DEPTH {
        return None;
    }
    let board_row = if side == Side::A { row } else { (board.rows - 1) - row };
    Some((col, board_row))
}

pub(crate) fn manhattan(a: (i32, i32), b: (i32, i32)) -> i32 {
    (a.0 - b.0).abs() + (a.1 - b.1).abs()
}
