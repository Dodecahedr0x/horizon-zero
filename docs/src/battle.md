# Battle rules

`horizon_combat::simulate` in `crates/combat` is the only rules engine. The program calls it from `settle_match`. The browser calls the wasm export `simulate_json`. Both must see the same winner and the same trace.

The crate's modules follow this chapter: `ids` (the byte enums), `behavior` (body format and standard bodies), `catalog` (unit stats and casts, the `ashborn_stats`, `rootborn_stats`, and `deeplings_stats` tables), `board` (geometry and blocked tiles), `trace` (events and line format), and the private `engine`. Inside the engine a `Battle` holds the fighters, the board, the seed, the round and the trace sink; turns, targeting (`engine/target.rs`), movement (`engine/movement.rs`) and attacks and casts (`engine/actions.rs`) are its methods. `lib.rs` re-exports the public items, so callers use `horizon_combat::simulate`, `horizon_combat::Effect` and so on, and holds `sha256`, which the program also uses for its VRF caller seed.

```text
simulate(side_a, side_b, seed, geometry) -> (winner, events)
```

`geometry` is `cols` and `rows`. `winner` is `Some(0)` for side A, `Some(1)` for side B, or `None` for a draw. The last event is that same result. A board is playable when `cols` is `1..=32`, `rows` is `4..=10`, and `cols * rows` is at most 120 (`MAX_COLS`, `MAX_ROWS`, `MAX_TILES`). Citadel's 12×10 is the largest area; 30×4 is the widest board. Past those caps `settle_match` does not fit: on 16×10 and 12×12 full armies run the 32 KiB heap out, and on 8×15 or 6×20 the longer walk between the zones passes the 1.4M compute-unit limit. Anything else resolves as a draw with a single end event. The program rejects that grid in `create_battleground`, so a stored battle never takes the fallback.

Wasm input is JSON: `cols`, `rows`, `a` and `b` as arrays of `{kind, body, col, row, cost, hp, atk, range, speed, actions, cast}`, and `seed` as 32 integers. `body` is the canonical behavior byte array; one that does not parse plays as the empty sequence. `col` and `row` are zone-local. `cast` is `{damage, range, aoe, effect, aim, power, rounds, cooldown}`; the last five default to `0` when absent, and an unknown `effect` or `aim` is an error, and so is an `hp`, `atk`, `range`, `speed` or `actions` outside `0..=1000` (`{"error":"speed 1001 is outside 0..=1000"}`), so a browser input cannot overflow the engine or stall it. Those stat fields are the values stored on the unit. The output is `{winner, lines}`. A seed that is not 32 bytes returns `{"error":"seed must be 32 bytes"}`. An unplayable board returns `{"error":"board is not playable"}`. `blocked_json(cols, rows, seed)` returns the blocked tiles as `{col, row}` objects, in row-then-column order. `hash_behavior(body)` returns the hex SHA-256 of those bytes.

## On-chain cost

`settle_match` calls `simulate_winner`, which plays the same battle as `simulate` without keeping the trace. On a Solana target every SHA-256 (tie keys, initiative, blocked-tile order, behavior hashes) goes through the `sol_sha256` syscall; other builds use the `sha2` crate, with identical output. Tie keys are hashed only when two candidates tie on the primary key, and a step attempt that neither moves nor fires anything ends the element's remaining attempts, because each would repeat the same no-op; the movement points are spent either way. The program heap is 32 KiB and never frees, so the hot paths use fixed arrays, the flood fill reuses one buffer, and the spawn-time body check (`BehaviorBody::is_valid`) reads the element and action counts instead of re-encoding the body. None of this changes a trace: 400 random battles replay identically before and after.

Walking distance dominates a battle's cost, so `Field` keeps one wave per goal tile (8 kept, the oldest replaced). Rubble never moves and units are not walls, so a goal's distances never change during a battle: the wave grows from the goal one step at a time, as one bit mask per row over only the rows it has reached, records each tile's distance as it reaches it, and stops once the tiles asked about are reached. A later question about the same goal continues that wave. Waves use two frontier buffers so a step neither clears nor copies one, and they live on the heap, allocated once. A unit already next to its goal skips the lookup, since no step can get closer. Occupied tiles are a bit mask per row kept in step with every move, push and death, so a step candidate is one lookup instead of a scan of the fighters. `seed_match` and `settle_match` check the battle address with one `create_program_address` on the stored canonical bump instead of a bump search. The wave step and the distance and rubble lookups (`Field::grow_walk`, `walking_distances`, `is_blocked` in `board.rs`) index without bounds checks: each `unsafe` block states why its indices are in range (rows below `rows`, a reached bit below `cols`, a tile already checked to be on the board) and repeats it as a `debug_assert!`, which the test suite exercises. These are the only `unsafe` blocks in the engine. The [Testing](testing.md#compute-benchmark) chapter has the benchmark these were measured with.

## Ids

Every id space in `crates/combat` is a `#[repr(u8)]` enum whose discriminant is the byte used everywhere else: behavior bodies, account fields, the wasm JSON, and trace lines. They are `MoveKind`, `Extremum`, `Stat`, `TargetSide`, `Stop`, `Verb`, `Side`, `Race`, `AshbornKind`, `RootbornKind`, `DeeplingsKind`, `Effect`, and `Aim` (catalog `self` is `Aim::Caster`). `from_u8` is the only way in from a byte, so an unknown value is rejected where it is read: `BehaviorBody::parse` fails, `simulate_json` returns `{"error":"unknown cast effect N"}` or `unknown cast aim`, and `settle_match` fails with `BadUnit`. Snapshots and `stats_for` keep the unit kind as a `u8` because kind ids are per race; `stats_for` reads it with the race's kind enum. Trace lines print each enum as its byte, so the line format did not change when the ids became enums.

## Deployment

Zone depth is 2. Zone A is board rows `0` and `1`, every column. Zone B is the last two board rows, every column. An army stores each unit inside the owner's zone: `col` in `0..cols`, `row` `0` or `1`. Local row `0` is that player's back row.

```text
board_col = local_col
board_row = local_row                 if side A
board_row = (rows - 1) - local_row    if side B
```

Side A local row `0` lands on board row `0`. Side B local row `0` lands on the last board row. The same army can be built before anyone knows which side it will be. The seed is not an input to this mapping.

The function reads at most 10 units (`MAX_UNITS`). A unit with `hp` at or below 0 is skipped. A zone-local position outside the zone is skipped. A second unit that would share a board tile is skipped. The program rejects those rosters before a snapshot is stored. A behavior that does not parse is played as an empty sequence: the unit does not move or act, then defends if it still has an action point. The program never stores such a body; this fallback exists only inside `simulate`. Kind ids are not looked up here. The snapshot already carries the stats and the cast.

## Blocked tiles

Blocked tiles are generated from `(geometry, seed)` and only on cells in neither starting zone. The same inputs always yield the same set.

1. Candidates are every cell with row in `2 .. rows-2`, walked after sorting by `SHA-256(seed || [col, row])`, then row, then column.
2. A candidate is blocked only when a 4-neighbor flood fill from `(0, 0)` can still reach a zone-B cell afterward.
3. Stop at `floor(non_zone_tiles / 5)` blocked cells. `non_zone_tiles` is `cols * (rows - 4)`.

Outpost (8×6) has 16 non-zone tiles and at most 3 blocked. Garrison (10×8) has 40 and at most 8. Citadel (12×10) has 72 and at most 14. A one-column board whose middle is a single file blocks nothing, because any block would disconnect the zones.

A living unit occupies one tile. A step onto a blocked tile or onto another living unit is not a candidate, so that step does not happen. A dead unit does not block a tile. Starting-zone tiles are never blocked, so deployment itself never starts on rubble.

## Stats

`stats_for(race, kind)` is the catalog. It is a `match` on the race and then on the kind. Ashborn is race `0` (`ashborn_stats`), Rootborn is race `1` (`rootborn_stats`), and Deeplings is race `2` (`deeplings_stats`). A race or kind with no arm returns nothing, so Rootborn kind `3` does not exist even though Ashborn kind `3` does. `army_cost(race, kinds)` sums those costs and returns nothing if any kind is unknown or the sum overflows `u16`. Army creation copies cost, hp, atk, attack range, speed, and the cast onto the unit. `simulate` reads that copy. It does not look the kind up again.

## Initiative

Fighters are ordered once, before round 0, and that order is reused every round. The sort key is:

1. `SHA-256(seed || [side, index])`, compared as 32 bytes, smaller first
2. side
3. index

## Round

There are at most 12 rounds. A round does not start when either side has no living unit. Defense is reset to 0 at the start of each round. Inside a round, each living fighter in initiative order runs its sequence, and the loop stops early when the other side is wiped.

Movement points for the turn equal `speed`, times `1 + power` while the unit carries a sprint. Action points equal the unit's stored `actions`; every unit of both races has 1, and the stat exists so a later unit can have more. Speed does not change it. A unit spends those pools across the whole sequence.

Each element:

1. If the element has a movement, pay for it and step. A movement attempts steps until the turn's movement points are spent, and the pool is 0 afterward even when a later step is blocked. The count is of steps already attempted this turn, checked before each step, so a sprint cast during the run lengthens it at once. If no living unit on the movement's side matches the target, the unit does not move, and the points are still spent. An element with a movement does nothing at all once the turn's movement points are spent, by an earlier element or because `speed` is 0: it takes no step and tries none of its actions, since its actions are tried only after its step attempts. The movement's last byte is `stop`. The byte before that is `side`.
2. After every step attempt, and once at the start of an element that has no movement, each action in the element is tried in order. An action fires when an action point remains and a living unit on that action's side is inside its range. It spends 1 action point and deals damage. An action that never has a target in range never fires and spends nothing, and it does not stop the unit.

`stop` is `0` or `1`. Any other value is rejected when the body is parsed. `0` continues: the unit keeps stepping, and an action can fire again on a later step of that element. `1` stops the rest of that element's movement once any action actually executes. A cast aimed at the caster itself (aim `self`) prepares the run rather than ending it, so it does not count for the stop. The step that just happened stays. The unit does not take its later steps, and the movement points those steps would have spent stay in the pool for later elements. Actions already due at the current tile still run, in order, while action points remain; the stop applies after that list, so the unit does not take another step in the element to look for a later action. An element with no movement has no `stop` byte.

After the sequence, if at least one action point remains, the unit defends: its defense becomes 1 for the rest of the round.

Damage taken is `max(0, amount - defender defense)`. Defense subtracts from each hit. Attack uses the unit's stored `atk` and its attack range, one target, and no effect. The attack range is the stored `range` plus the power of a reach status the unit carries.

## Casts

Every cast is the same eight numbers, stored on the unit. New casts are new values, not new code, unless they need a new effect.

| field | meaning |
| --- | --- |
| `damage` | dealt to each unit the cast lands on, before the effect; `0` deals none |
| `range` | Manhattan reach to the chosen target; ignored for aim `self` |
| `aoe` | radius around the chosen target; `0` lands on the target only |
| `effect` | what happens to each unit it lands on, below |
| `aim` | who it may pick, below |
| `power` | the effect's size |
| `rounds` | how long a lasting effect stays, counting the round it lands in |
| `cooldown` | rounds after the round it fires during which the caster cannot cast again; `0` casts every round |

| aim | id | picks from |
| --- | --- | --- |
| chosen | 0 | the side the behavior action names, as for an attack |
| foe | 1 | living units of the other side, whatever the action says |
| ally | 2 | living units of the caster's side, the caster included |
| self | 3 | the caster only; `range` and the action's target are ignored |

| effect | id | on each unit it lands on |
| --- | --- | --- |
| none | 0 | nothing beyond the damage |
| push | 1 | moved `power` tiles straight away from the caster |
| sprint | 2 | movement points × `1 + power`, lasting |
| reach | 3 | attack range + `power`, lasting |
| taunt | 4 | every movement it makes walks toward the caster, lasting |
| heal | 5 | hp + `power`, never above the hp it started the battle with |

The action's extremum and stat still order the candidates the aim allows. A cast skips any candidate it would not change (`cast_changes`). A cast with `damage` above 0 skips no one. When `damage` is 0: a heal skips units at full hp and, with `power` 0, everyone; a lasting effect (sprint, reach, taunt) skips units that already carry it and, with `rounds` 0, everyone, whatever its `power`, so a 0-power taunt still lands; a push with `power` 0 skips everyone; and effect none skips everyone. A cast with no candidate inside its range does not fire and spends nothing. One cast spends 1 action point.

`aoe` greater than 0 also lands on every other living unit on the chosen target's side within that Manhattan radius of the target's tile, with the same skip rule. A foe cast does not touch allies. An ally cast does not touch enemies, and it can land on the caster. A self cast with `aoe` above 0 is centred on the caster: it also lands on the caster's allies within that radius, and its `damage`, when above 0, hits the caster and those allies. Each unit is its own cast line, the chosen target first. Every unit takes its damage first; the effect then lands on each unit still alive, in the same order.

A push moves the unit one orthogonal tile at a time along the axis with the larger absolute separation from the caster. Column wins a tie. It stops early when the next tile is blocked, off the board, or occupied by a living unit. A unit that died from the hit is not pushed and does not block a tile.

A lasting effect is a status on the unit: effect, power, rounds left, and the caster. A unit holds at most 4 statuses. A second status of the same effect replaces the first, so a recast refreshes it. At the end of every round each status loses a round; one that reaches 0 ends, and a living unit gets an `X` line for it. A taunt whose caster has died is ignored until it ends. While a taunt holds, each step the unit takes is an approach step toward its caster, whatever the movement kind and target say.

The trace records damage taken and the target's hp as `max(hp, 0)` after the effect. Hp at or below 0 emits a death event after that unit's cast line.

### Ashborn casts

| unit | cast | damage | range | aoe | effect | aim | power | rounds | cooldown |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Guard | shield bash: 9 damage and pushes a foe 1 tile back | 9 | 2 | 0 | push | foe | 1 | 0 | 0 |
| Skirmisher | sprint: doubles its movement for 3 rounds | 0 | 0 | 0 | sprint | self | 1 | 3 | 4 |
| Archer | long draw: +2 attack range for 3 rounds | 0 | 0 | 0 | reach | self | 2 | 3 | 4 |
| Vanguard | challenge: the target and foes within 1 of it walk toward the Vanguard for 3 rounds | 0 | 2 | 1 | taunt | foe | 0 | 3 | 4 |
| Warden | mending: heals one ally or itself for up to 5 | 0 | 3 | 0 | heal | ally | 5 | 0 | 0 |

### Rootborn casts

| unit | cast | damage | range | aoe | effect | aim | power | rounds | cooldown |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Thornling | thorn burst: 6 damage to a foe in reach and to foes within 1 of it | 6 | 1 | 1 | none | foe | 0 | 0 | 3 |
| Briarsling | thorn sling: 12 damage to one foe, pushed 1 tile away from the Briarsling | 12 | 4 | 0 | push | foe | 1 | 0 | 4 |
| Elderoak | hearth sap: heals an ally (or itself) and allies within 1 of it for up to 5 each | 0 | 3 | 1 | heal | ally | 5 | 0 | 3 |

### Deeplings casts

| unit | cast | damage | range | aoe | effect | aim | power | rounds | cooldown |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Clawling | crush: 15 damage to one foe in reach | 15 | 1 | 0 | none | foe | 0 | 0 | 2 |
| Eelsnare | snare: the target walks toward the Eelsnare for 2 rounds | 0 | 3 | 0 | taunt | foe | 0 | 2 | 3 |
| Spineshot | spine spray: 3 damage to a foe and foes within 1 of it | 3 | 3 | 1 | none | foe | 0 | 0 | 2 |
| Tidecaller | undertow: 9 damage to a foe and foes within 1 of it, each pushed 2 tiles away from the Tidecaller | 9 | 3 | 1 | push | foe | 2 | 0 | 2 |

A cast that fires in round `r` with cooldown `c` cannot fire again before round `r + c + 1`. While it cools down, a cast action does not fire and spends nothing, so the next action in the element runs: the cast-then-attack standards attack. The Ashborn rule is that a cast lasting more than one round has a cooldown at least as long as its effect, and an instant cast has none. Rootborn and Deeplings casts all cool down, instant ones included, because most of them hit or heal an area or hit harder than an attack and would otherwise replace the attack every round. The Eelsnare's snare is a taunt that lasts 2 rounds with a cooldown of 3. With `rounds` 3 and `cooldown` 4, a sprint, a long draw or a challenge holds for three rounds and is then gone for two before it can be cast again.

A self cast fires the first time its action is tried in a turn (in an element with a movement, that is right after the first step attempt), and it is not recast while its status holds. Every unit has one action point, so a Skirmisher that sprints or an Archer that draws long does not also attack that round.

If both sides still have a living unit after round 12, the result is a draw and the last trace line is `E draw limit`. The interpreter does not start a 13th round. If both sides are dead, the result is a draw and the last line is `E draw`. Otherwise the side that still has a living unit wins, and the last line is `E 0` or `E 1`. Each round that starts appends `R` after that round's other events. A round that never starts, because a side is already wiped, does not append `R`.

## Targeting

Movement and each action choose their own target and a side. Side `0` is a living unit on the other side. Side `1` is another living unit on the actor's side, never the actor. An action only considers units on that side inside its range. If the chosen side has nobody, the movement still spends its points and the unit does not move, and the action does not fire and spends nothing. The primary key is the named stat:

| stat | id | value |
| --- | --- | --- |
| Distance | 0 | Manhattan distance from the actor |
| HP | 1 | that unit's hp |
| ATK | 2 | that unit's atk |

Lowest (`0`) prefers the smaller value. Highest (`1`) prefers the larger value. A tie uses `SHA-256(seed || [actor.side, actor.index, enemy.side, enemy.index, round as u8])`, smaller first. `round` fits in a byte because the cap is 12. The target is chosen again for every step and every action. Approach, flee, and flank use the chosen unit as the reference tile, unless a taunt holds. Attack and cast pick that unit; a cast whose aim is not `chosen` replaces the side as described under Casts. An ally attack, or a cast aimed `chosen` at an ally, can damage allies.

## Movement

A step is one of `(+1, 0)`, `(-1, 0)`, `(0, +1)`, `(0, -1)`. The tile must be inside the board, not a blocked tile, and empty of other living units. When several tiles qualify, the winner is the one with the better distance, then the smaller tie key:

```text
SHA-256(seed || [side, index, round as u8, step as u8, col as u8, row as u8])
```

`step` is the attempt's index within the current element: `0` for the element's first step attempt, then one more for each attempt after it, back to `0` at the next element with a movement. `col` and `row` are the candidate tile.

| kind | id | rule |
| --- | --- | --- |
| Approach | 0 | the step that most reduces walking distance to the chosen unit |
| Flee | 1 | a step that strictly increases Manhattan distance from that unit |
| Flank left | 2 | close in from the left of the line toward the chosen unit |
| Flank right | 3 | the same from the right |

Walking distance is the number of orthogonal steps to the chosen unit's tile over tiles that are not rubble, so an approach goes around rubble instead of stopping in front of it. Living units do not count as walls for this distance; a step still cannot enter an occupied tile. If the chosen unit cannot be walked to at all, approach and flank use Manhattan distance instead. `Field::walking_distances` grows a wave from the goal one row bit mask at a time and stops once the actor's tile and its candidate steps are reached. Its frontiers are fixed arrays; each kept wave's per-tile distance table (`Walk.steps`, a `Vec<u16>` of `cols * rows`) is allocated on the heap the first time that slot is used and reused after.

On this grid `+col` is east and `+row` is south. A flank's side is the line from the actor to the chosen unit turned left, `(dc, dr)` becoming `(dr, -dc)`, or right, `(-dr, dc)`. When that unit is straight ahead (same row or column) and more than 2 tiles away by walking distance, the flanker steps one tile sideways toward its side if that tile is legal. Otherwise it takes the step that reduces walking distance and lies furthest toward its side (the largest dot product with the side vector), then the smaller tie key. Every step but the sidestep gets closer, and after a sidestep the unit is no longer straight ahead, so a flanker always arrives. If the chosen side has no unit, or no step gets closer, the step does not move the unit.

A present movement always spends the whole pool. There is no walk mode and no mode byte. Stop-if-an-action-triggers is `stop` `1`. Continue is `stop` `0`.

## Trace

One line per event, ending in a newline. `trace_text` joins them. Damage is the amount actually taken, after defense.

Clients never index the split fields themselves: `content/trace.mjs` (`parseTraceLine`) turns a line into named fields (`actor`, `target`, `damage`, `hp`, `effect` as a name, `amount`, `rounds`, `from`, `to`, `winner`, `limit`), using the id names in `content/ids.mjs`. The game's chronicle, health bars and trial summary, the shared board, and the studio's step sentences, event filters and Balance totals all read lines through it, and `content/trace.test.mjs` checks it against a real battle. The studio serves `content/ids.mjs`, `content/trace.mjs` and `content/catalog.json` to its browser so the board loads the same modules there.

```text
M <side> <index> <from_col> <from_row> <to_col> <to_row>
A <side> <index> <target_side> <target_index> <damage> <target_hp>
C <side> <index> <target_side> <target_index> <damage> <target_hp> <effect> <amount> <rounds> <from_col> <from_row> <to_col> <to_row>
F <side> <index>
D <side> <index>
X <side> <index> <effect>
R
E <side>
E draw
E draw limit
```

`A` is an attack, `C` is a cast, and `F` is the unit defending for the rest of the round. A cast line names one unit it landed on; a self cast names the caster as its own target. `effect` is the effect id. `amount` is what it did: tiles pushed, hp restored, or the power of a lasting effect, `0` for none. `rounds` is how long a lasting effect stays, `0` otherwise. `target_hp` is after the damage and the heal. `from` is the unit's tile when the cast landed and `to` is its tile after a push. They are equal when it did not move. `X` is a lasting effect ending on a living unit at the end of a round, just before `R`. `R` is the end of a round that started. `E draw limit` is a draw because both sides still have a living unit after round 12. `E draw` is any other draw. A move line is emitted for each step that changes the tile, so an attack or cast can sit between two moves of the same run. The golden vector `crates/combat/golden/advance.txt` is two catalog Guards on Outpost (8×6), both March (approach lowest distance, then attack lowest distance, stop if an action fires) at zone-local `(0, 0)`, seed bytes all `9`. That seed puts rubble on column 0 between them, so both walk around it to column 2, meet in round 2, trade blows, and side B wins in round 3: the trace ends `E 1`. Under the old straight-line approach the same pair stopped in front of the rubble and drew after 12 rounds. `app/src/golden.test.mjs` replays that file through the node wasm build.
