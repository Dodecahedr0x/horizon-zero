//! Rules tests. They reach into the engine through crate-private items.

use crate::board::{zones_connected, Field, Fill};
use crate::engine::{push_side, Battle, Fighter, Status};
use crate::trace::Trace;
use crate::*;

fn outpost() -> Geometry {
    Geometry { cols: 8, rows: 6 }
}

/// A unit with fixed test stats. Rule tests use these, not the catalog, so retuning the catalog
/// cannot change what a rule test checks. `catalog_unit` is the live catalog row.
fn unit(kind: AshbornKind, behavior: BehaviorBody, col: u8, row: u8) -> SnapshotUnit {
    let mut unit = catalog_unit(kind, behavior, col, row);
    let (hp, atk, range, speed, cast) = match kind {
        AshbornKind::Guard => (6, 1, 1, 1, Cast { damage: 1, range: 1, aoe: 0, effect: Effect::Push, aim: Aim::Foe, power: 2, rounds: 0, cooldown: 0 }),
        AshbornKind::Skirmisher => (4, 2, 1, 3, Cast { damage: 0, range: 0, aoe: 0, effect: Effect::Sprint, aim: Aim::Caster, power: 1, rounds: 1, cooldown: 0 }),
        AshbornKind::Archer => (3, 2, 3, 2, Cast { damage: 0, range: 0, aoe: 0, effect: Effect::Reach, aim: Aim::Caster, power: 2, rounds: 3, cooldown: 0 }),
        AshbornKind::Vanguard => (7, 3, 1, 2, Cast { damage: 0, range: 3, aoe: 1, effect: Effect::Taunt, aim: Aim::Foe, power: 0, rounds: 2, cooldown: 0 }),
        AshbornKind::Warden => (9, 2, 1, 1, Cast { damage: 0, range: 2, aoe: 1, effect: Effect::Heal, aim: Aim::Ally, power: 3, rounds: 0, cooldown: 0 }),
    };
    (unit.hp, unit.atk, unit.range, unit.speed, unit.actions, unit.cast) = (hp, atk, range, speed, 1, cast);
    unit
}

fn catalog_unit(kind: AshbornKind, behavior: BehaviorBody, col: u8, row: u8) -> SnapshotUnit {
    SnapshotUnit::catalog(Race::Ashborn.id(), kind.id(), behavior, col, row).unwrap()
}

/// A unit that stands still and never acts or defends: no action points.
fn dummy(kind: AshbornKind, col: u8, row: u8) -> SnapshotUnit {
    let mut unit = unit(kind, still(), col, row);
    unit.actions = 0;
    unit
}

fn connected(board: Geometry, blocked: &[(i32, i32)]) -> bool {
    let mut fill = Fill::new(board);
    for &(col, row) in blocked {
        fill.blocked[(row * board.cols + col) as usize] = true;
    }
    zones_connected(board, &mut fill)
}

fn still() -> BehaviorBody {
    BehaviorBody::parse(&[1, 0, 0]).unwrap()
}

fn lane(rows: i32) -> Geometry {
    Geometry { cols: 1, rows }
}

#[test]
fn behavior_hash_is_sha256_of_the_canonical_bytes() {
    let body = behavior_march();
    let bytes = body.canonical_bytes();
    assert_eq!(bytes, vec![1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0]);
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let expected: [u8; 32] = hasher.finalize().into();
    assert_eq!(behavior_hash(&bytes), expected);
    assert_ne!(behavior_hash(&bytes), behavior_hash(&behavior_charge().canonical_bytes()));
    assert_eq!(behavior_charge().canonical_bytes(), vec![1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    assert_eq!(behavior_kite().canonical_bytes(), vec![2, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
    assert_eq!(behavior_flank_left().canonical_bytes(), vec![1, 1, 2, 0, 0, 0, 0, 1, 0, 1, 2, 0]);
    assert_eq!(behavior_flank_right().canonical_bytes(), vec![1, 1, 3, 0, 0, 0, 0, 1, 0, 1, 2, 0]);
    assert_eq!(behavior_march_cast().canonical_bytes(), vec![1, 1, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(behavior_charge_cast().canonical_bytes(), vec![1, 1, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(behavior_kite_cast().canonical_bytes(), vec![2, 1, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
    assert_eq!(behavior_flank_left_cast().canonical_bytes(), vec![1, 1, 2, 0, 0, 0, 0, 2, 1, 1, 2, 0, 0, 1, 2, 0]);
    assert_eq!(behavior_flank_right_cast().canonical_bytes(), vec![1, 1, 3, 0, 0, 0, 0, 2, 1, 1, 2, 0, 0, 1, 2, 0]);
}

#[test]
fn canonical_body_rejects_empty_and_oversized_sequences() {
    assert!(BehaviorBody::parse(&[]).is_none());
    assert!(BehaviorBody::parse(&[0]).is_none());
    assert!(BehaviorBody::parse(&[5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).is_none());
    assert!(BehaviorBody::parse(&[1, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).is_none());
    assert!(BehaviorBody::parse(&[1, 0, 0, 9]).is_none());
    assert!(BehaviorBody::parse(&[1, 2, 0, 0, 0, 0, 0]).is_none());
    assert!(BehaviorBody::parse(&[1, 1, 0, 0, 0, 0, 2, 0]).is_none());
    assert!(BehaviorBody::parse(&[1, 1, 0, 0, 0, 2, 0]).is_none());
    assert!(BehaviorBody::parse(&[1, 1, 4, 0, 0, 0, 0]).is_none());
    assert!(BehaviorBody::parse(&[1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]).is_none());
    assert!(BehaviorBody::parse(&[1, 1, 0, 0, 0, 2, 0, 0]).is_none());
    assert!(BehaviorBody::parse(&[1, 0, 1, 0, 0, 0, 2]).is_none());
    assert!(still().is_valid());
}

#[test]
fn is_valid_matches_the_canonical_round_trip() {
    let round_trip = |body: BehaviorBody| BehaviorBody::parse(&body.canonical_bytes()).is_some();
    let mut bodies = vec![BehaviorBody::default(), still(), behavior_kite_cast(), behavior_flank_left_cast()];
    for len in [0u8, 1, 4, 5, 255] {
        for action_len in [0u8, 3, 4, 200] {
            let mut body = behavior_charge_cast();
            body.len = len;
            for element in body.elements.iter_mut() {
                element.action_len = action_len;
            }
            bodies.push(body);
        }
    }
    let mut late = behavior_charge_cast();
    late.len = 1;
    late.elements[1].action_len = 9;
    bodies.push(late);
    for body in bodies {
        assert_eq!(body.is_valid(), round_trip(body), "{body:?}");
    }
}

#[test]
fn still_units_draw_when_the_round_limit_is_reached() {
    let seed = [7u8; 32];
    let (winner, events) = simulate(&[dummy(AshbornKind::Guard, 0, 0)], &[dummy(AshbornKind::Guard, 0, 0)], seed, outpost());
    assert_eq!(winner, None);
    let rounds = events.iter().filter(|event| matches!(event, TraceEvent::Round)).count();
    assert_eq!(rounds, MAX_ROUNDS as usize);
    assert!(events.iter().all(|event| !matches!(event, TraceEvent::Move { .. } | TraceEvent::Attack { .. } | TraceEvent::Cast { .. } | TraceEvent::Death { .. })));
    assert_eq!(events.last().copied(), Some(TraceEvent::End { winner: None, limit: true }));
    assert_eq!(events.last().unwrap().to_line(), "E draw limit");
}

#[test]
fn a_wipe_ends_before_the_round_limit() {
    let attack = BehaviorBody::parse(&[1, 0, 1, 0, 0, 0, 0]).unwrap();
    let (winner, events) = simulate(&[unit(AshbornKind::Archer, attack, 0, 0)], &[unit(AshbornKind::Archer, still(), 0, 0)], [0u8; 32], lane(4));
    assert_eq!(winner, Some(Side::A));
    let rounds = events.iter().filter(|event| matches!(event, TraceEvent::Round)).count();
    assert!(rounds > 0 && rounds < MAX_ROUNDS as usize);
    assert!(events.iter().any(|event| matches!(event, TraceEvent::Death { side: Side::B, .. })));
    assert_eq!(events.last().copied(), Some(TraceEvent::End { winner: Some(Side::A), limit: false }));
    assert_eq!(events.last().unwrap().to_line(), "E 0");
}

#[test]
fn same_seed_replays_the_same_trace() {
    let seed = [3u8; 32];
    let a = [unit(AshbornKind::Vanguard, behavior_charge(), 1, 0)];
    let b = [unit(AshbornKind::Archer, behavior_kite(), 2, 0), unit(AshbornKind::Guard, behavior_flank_left(), 3, 1)];
    let board = Geometry { cols: 10, rows: 8 };
    let first = simulate(&a, &b, seed, board);
    let second = simulate(&a, &b, seed, board);
    assert_eq!(first, second);
    assert!(first.1.iter().any(|event| matches!(event, TraceEvent::Attack { .. } | TraceEvent::Cast { .. } | TraceEvent::Defend { .. })));
}

#[test]
fn advance_golden_trace() {
    let seed = [9u8; 32];
    let (winner, events) = simulate(&[catalog_unit(AshbornKind::Guard, behavior_march(), 0, 0)], &[catalog_unit(AshbornKind::Guard, behavior_march(), 0, 0)], seed, outpost());
    let text = trace_text(&events);
    let expected = include_str!("../golden/advance.txt");
    assert_eq!(text, expected, "winner={winner:?}");
}

#[test]
fn catalog_costs_match_the_plan() {
    assert_eq!(army_cost(Race::Ashborn.id(), &[AshbornKind::Warden.id(), AshbornKind::Warden.id(), AshbornKind::Archer.id()]), Some(13));
    assert!(stats_for(Race::Ashborn.id(), 9).is_none());
    assert_eq!(army_cost(Race::Rootborn.id(), &[RootbornKind::Elderoak.id(), RootbornKind::Thornling.id()]), Some(14));
    assert_eq!(army_cost(Race::Deeplings.id(), &[DeeplingsKind::Clawling.id(), DeeplingsKind::Tidecaller.id()]), Some(9));
    assert!(stats_for(Race::Deeplings.id(), 4).is_none());
    assert!(stats_for(Race::Rootborn.id(), AshbornKind::Vanguard.id()).is_none());
    assert!(stats_for(3, AshbornKind::Guard.id()).is_none());
    assert!(!race_known(3));
    assert!(race_known(Race::Ashborn.id()));
    assert!(race_known(Race::Rootborn.id()));
    assert!(race_known(Race::Deeplings.id()));
}

#[test]
fn ashborn_is_cheapest_deeplings_average_rootborn_dearest() {
    // Mean unit cost per race, times 100 to stay in integers.
    let mean = |race: Race, kinds: &[u8]| kinds.iter().map(|&kind| stats_for(race.id(), kind).unwrap().cost as u32).sum::<u32>() * 100 / kinds.len() as u32;
    let ashborn = mean(Race::Ashborn, &AshbornKind::ALL.iter().map(|kind| kind.id()).collect::<Vec<_>>());
    let deeplings = mean(Race::Deeplings, &DeeplingsKind::ALL.iter().map(|kind| kind.id()).collect::<Vec<_>>());
    let rootborn = mean(Race::Rootborn, &RootbornKind::ALL.iter().map(|kind| kind.id()).collect::<Vec<_>>());
    assert!(ashborn < deeplings && deeplings < rootborn, "mean costs {ashborn} < {deeplings} < {rootborn}");
    assert_eq!(stats_for(Race::Rootborn.id(), RootbornKind::Thornling.id()).unwrap().cost, 4, "the Thornling keeps its cost of 4");
    for kind in DeeplingsKind::ALL {
        let unit = stats_for(Race::Deeplings.id(), kind.id()).unwrap();
        assert_eq!(unit.actions, 1);
        if unit.cast.effect.lasts() {
            assert!(unit.cast.cooldown >= unit.cast.rounds, "{kind:?} lasts {} rounds, so it needs a cooldown at least that long", unit.cast.rounds);
        }
    }
}

#[test]
fn rootborn_roles_hold_in_the_catalog() {
    let stats = |kind: RootbornKind| stats_for(Race::Rootborn.id(), kind.id()).unwrap();
    let all = RootbornKind::ALL.iter().map(|&kind| stats(kind)).collect::<Vec<_>>();
    let ashborn = AshbornKind::ALL.iter().map(|&kind| stats_for(Race::Ashborn.id(), kind.id()).unwrap()).collect::<Vec<_>>();
    assert!(all.len() < ashborn.len(), "Rootborn fields fewer kinds");
    let cheapest = all.iter().map(|unit| unit.cost).min().unwrap();
    let ashborn_cheapest = ashborn.iter().map(|unit| unit.cost).min().unwrap();
    assert!(cheapest >= 2 * ashborn_cheapest, "the cheapest Rootborn costs at least twice the cheapest Ashborn");
    assert!(all.iter().all(|unit| unit.actions == 1), "every Rootborn unit has one action point");
    for unit in &all {
        if matches!(unit.cast.aim, Aim::Caster | Aim::Ally) {
            assert_eq!(unit.cast.damage, 0, "a cast on the caster or allies never hurts them");
        }
        assert!(unit.cast.cooldown > 0, "every Rootborn cast cools down");
    }
    let elderoak = stats(RootbornKind::Elderoak);
    assert!(all.iter().all(|unit| unit.hp <= elderoak.hp && unit.cost <= elderoak.cost), "the Elderoak is the largest and costliest");
    assert!(all.iter().all(|unit| unit.range <= stats(RootbornKind::Briarsling).range), "the Briarsling has the longest reach");
}

#[test]
fn ashborn_roles_hold_in_the_catalog() {
    // Exact numbers live in catalog.rs and catalog.json (checked against each other below); these
    // are the role rules the tuning must keep.
    let stats = |kind: AshbornKind| stats_for(Race::Ashborn.id(), kind.id()).unwrap();
    let all = AshbornKind::ALL.iter().map(|&kind| stats(kind)).collect::<Vec<_>>();
    assert!(all.iter().all(|unit| unit.actions == 1), "every Ashborn unit has one action point");
    let casts = all.iter().map(|unit| (unit.cast.effect, unit.cast.aim)).collect::<Vec<_>>();
    assert_eq!(casts, vec![(Effect::Push, Aim::Foe), (Effect::Sprint, Aim::Caster), (Effect::Reach, Aim::Caster), (Effect::Taunt, Aim::Foe), (Effect::Heal, Aim::Ally)]);
    for unit in &all {
        let cast = unit.cast;
        if matches!(cast.aim, Aim::Caster | Aim::Ally) {
            assert_eq!(cast.damage, 0, "a cast on the caster or allies never hurts them");
        }
        if cast.effect != Effect::Taunt {
            assert!(cast.power > 0, "{:?} needs power to do anything", cast.effect);
        }
        if cast.effect.lasts() {
            assert!(cast.rounds > 0, "{:?} must last", cast.effect);
        }
        if cast.rounds > 1 {
            assert!(cast.cooldown >= cast.rounds, "{:?} lasts {} rounds, so it needs a cooldown at least that long", cast.effect, cast.rounds);
        } else {
            assert_eq!(cast.cooldown, 0, "only casts that last several rounds cool down");
        }
    }
    let skirmisher = stats(AshbornKind::Skirmisher);
    assert!(all.iter().all(|unit| unit.speed <= skirmisher.speed), "the Skirmisher is the fastest");
    assert!(all.iter().all(|unit| unit.range <= stats(AshbornKind::Archer).range), "the Archer has the longest reach");
    assert!(all.iter().filter(|unit| unit.kind != AshbornKind::Archer.id()).all(|unit| unit.range == 1), "the others are melee");
}

/// A damage cast aimed where the behavior says, pushing `push` tiles when it is above 0.
fn blast(damage: u8, range: u8, aoe: u8, push: u8) -> Cast {
    let effect = if push > 0 { Effect::Push } else { Effect::None };
    Cast { damage, range, aoe, effect, aim: Aim::Chosen, power: push, rounds: 0, cooldown: 0 }
}

fn with_cast(kind: AshbornKind, behavior: BehaviorBody, col: u8, row: u8, cast: Cast) -> SnapshotUnit {
    let mut unit = unit(kind, behavior, col, row);
    unit.cast = cast;
    unit.speed = 2;
    unit
}

#[test]
fn cast_reads_stored_parameters_instead_of_attack_plus_one() {
    let cast = BehaviorBody::parse(&[1, 0, 1, 1, 0, 0, 0]).unwrap();
    let attack = BehaviorBody::parse(&[1, 0, 1, 0, 0, 0, 0]).unwrap();
    let far = blast(1, 3, 0, 0);
    let short = blast(9, 1, 0, 0);
    let (_, reached) = simulate(&[with_cast(AshbornKind::Guard, cast, 0, 0, far)], &[dummy(AshbornKind::Guard, 0, 0)], [0u8; 32], lane(4));
    assert!(reached.iter().any(|event| matches!(event, TraceEvent::Cast { damage: 1, .. })));
    let (_, missed) = simulate(&[with_cast(AshbornKind::Archer, cast, 0, 0, short)], &[dummy(AshbornKind::Guard, 0, 0)], [0u8; 32], lane(4));
    assert!(missed.iter().all(|event| !matches!(event, TraceEvent::Cast { .. })));
    let (_, swung) = simulate(&[unit(AshbornKind::Archer, attack, 0, 0)], &[dummy(AshbornKind::Guard, 0, 0)], [0u8; 32], lane(4));
    assert!(swung.iter().any(|event| matches!(event, TraceEvent::Attack { damage: 2, .. })));
    assert!(swung.iter().all(|event| !matches!(event, TraceEvent::Cast { .. })));
}

#[test]
fn aoe_hits_each_enemy_and_skips_allies() {
    let cast = BehaviorBody::parse(&[1, 0, 1, 1, 0, 0, 0]).unwrap();
    let board = Geometry { cols: 3, rows: 4 };
    let (_, events) = simulate(
        &[with_cast(AshbornKind::Vanguard, cast, 1, 1, blast(3, 1, 1, 0)), dummy(AshbornKind::Guard, 0, 1)],
        &[dummy(AshbornKind::Guard, 1, 1), dummy(AshbornKind::Guard, 2, 1)],
        [0u8; 32],
        board,
    );
    let first_round = &events[..events.iter().position(|event| matches!(event, TraceEvent::Round)).unwrap()];
    let hits: Vec<_> = first_round
        .iter()
        .filter_map(|event| match event {
            TraceEvent::Cast { target_side, target_index, damage, target_hp, amount, .. } => Some((target_side.id(), *target_index, *damage, *target_hp, *amount)),
            _ => None,
        })
        .collect();
    assert_eq!(hits, vec![(1, 0, 3, 3, 0), (1, 1, 3, 3, 0)]);
    assert!(first_round.iter().all(|event| !matches!(event, TraceEvent::Cast { target_side: Side::A, .. } | TraceEvent::Death { .. })));
}

#[test]
fn knockback_pushes_away_from_the_caster_and_stops_early() {
    let cast = BehaviorBody::parse(&[1, 0, 1, 1, 0, 0, 0]).unwrap();
    let shove = blast(1, 1, 0, 1);
    let (_, events) = simulate(&[with_cast(AshbornKind::Skirmisher, cast, 0, 1, shove)], &[dummy(AshbornKind::Guard, 0, 1)], [0u8; 32], lane(4));
    assert!(events.iter().any(|event| matches!(event, TraceEvent::Cast { effect: Effect::Push, amount: 1, from_col: 0, from_row: 2, to_col: 0, to_row: 3, damage: 1, .. })));

    let blocked = blast(1, 1, 0, 2);
    let fighters = vec![
        Fighter {
            side: Side::A,
            index: 0,
            col: 0,
            row: 1,
            hp: 6,
            atk: 1,
            range: 1,
            speed: 2,
            actions: 1,
            defense: 0,
            max_hp: 6,
            cast: blocked,
            behavior: still(),
            statuses: [Status::default(); MAX_STATUSES],
            cast_ready: 0,
        },
        Fighter {
            side: Side::B,
            index: 0,
            col: 0,
            row: 2,
            hp: 6,
            atk: 1,
            range: 1,
            speed: 1,
            actions: 1,
            defense: 0,
            max_hp: 6,
            cast: Cast::default(),
            behavior: still(),
            statuses: [Status::default(); MAX_STATUSES],
            cast_ready: 0,
        },
    ];
    let mut trace = Trace::recording();
    let mut battle = battle(fighters, Geometry { cols: 3, rows: 6 }, &[(0, 3)], &mut trace);
    assert_eq!(battle.shove(1, (0, 1), 2), 0);
    assert_eq!(battle.fighters[1].tile(), (0, 2));

    let crowded = Geometry { cols: 1, rows: 4 };
    let splash = blast(1, 1, 1, 1);
    let (_, crowded_events) =
        simulate(&[with_cast(AshbornKind::Skirmisher, cast, 0, 1, splash)], &[dummy(AshbornKind::Guard, 0, 1), dummy(AshbornKind::Warden, 0, 0)], [0u8; 32], crowded);
    let first_round = &crowded_events[..crowded_events.iter().position(|event| matches!(event, TraceEvent::Round)).unwrap()];
    let shoved: Vec<_> = first_round
        .iter()
        .filter_map(|event| match event {
            TraceEvent::Cast { target_index, from_row, to_row, amount, .. } => Some((*target_index, *from_row, *to_row, *amount)),
            _ => None,
        })
        .collect();
    assert_eq!(shoved, vec![(0, 2, 2, 0), (1, 3, 3, 0)]);
}

fn cast_lines(events: &[TraceEvent]) -> Vec<TraceEvent> {
    events.iter().copied().filter(|event| matches!(event, TraceEvent::Cast { .. })).collect()
}

#[test]
fn action_points_come_from_the_actions_stat_not_speed() {
    // Two attacks in the list; only as many fire per turn as the unit has action points.
    let twice = BehaviorBody::parse(&[1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]).unwrap();
    let attacks_in_first_round = |actions: i32, speed: i32| {
        let mut archer = unit(AshbornKind::Archer, twice, 0, 1);
        archer.actions = actions;
        archer.speed = speed;
        let mut target = dummy(AshbornKind::Warden, 0, 1);
        target.hp = 30;
        let (_, events) = simulate(&[archer], &[target], [0u8; 32], lane(4));
        events.iter().take_while(|event| !matches!(event, TraceEvent::Round)).filter(|event| matches!(event, TraceEvent::Attack { side: Side::A, .. })).count()
    };
    assert_eq!(attacks_in_first_round(1, 8), 1);
    assert_eq!(attacks_in_first_round(2, 1), 2);
    assert_eq!(attacks_in_first_round(0, 8), 0);
}

#[test]
fn approach_walks_around_rubble() {
    // Rubble straight between them: the old rule only took steps that cut straight-line distance,
    // so both stopped in front of it for the rest of the battle.
    let mut fighters = Vec::new();
    push_side(&mut fighters, Side::A, &[dummy(AshbornKind::Guard, 1, 1)], lane_board());
    push_side(&mut fighters, Side::B, &[dummy(AshbornKind::Guard, 1, 1)], lane_board());
    fighters[0].row = 1;
    fighters[1].row = 3;
    let mut trace = Trace::recording();
    let mut battle = battle(fighters, lane_board(), &[(1, 2)], &mut trace);
    let approach = Movement { kind: MoveKind::Approach, target: TargetSpec::default(), stop: Stop::Continue };
    assert!(battle.take_step(0, approach, 0), "the actor steps aside instead of standing still");
    let side_tile = battle.fighters[0].tile();
    assert!(side_tile == (0, 1) || side_tile == (2, 1));
    assert!(battle.take_step(0, approach, 1));
    assert_eq!(battle.fighters[0].tile(), (side_tile.0, 2), "then it passes the rubble");
}

#[test]
fn flank_arrives_instead_of_circling() {
    let flank = BehaviorBody::parse(&[1, 1, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0]).unwrap();
    let mut flanker = unit(AshbornKind::Guard, flank, 3, 0);
    flanker.speed = 2;
    let mut target = dummy(AshbornKind::Vanguard, 3, 0);
    target.hp = 99;
    let (_, events) = simulate(&[flanker], &[target], [3u8; 32], Geometry { cols: 8, rows: 10 });
    let first_hit = events.iter().position(|event| matches!(event, TraceEvent::Attack { side: Side::A, .. }));
    let rounds_before = first_hit.map(|at| events[..at].iter().filter(|event| matches!(event, TraceEvent::Round)).count());
    assert!(rounds_before.is_some_and(|rounds| rounds <= 6), "the flanker reaches its target: {rounds_before:?}");
    let moves: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            TraceEvent::Move { side: Side::A, from_col, to_col, .. } => Some(to_col - from_col),
            _ => None,
        })
        .collect();
    assert!(moves.iter().any(|delta| *delta != 0), "it leaves the straight line: {moves:?}");
}

/// Three columns, six rows: room to step around one tile.
fn lane_board() -> Geometry {
    Geometry { cols: 3, rows: 6 }
}

#[test]
fn a_cooldown_blocks_casting_and_the_unit_attacks_instead() {
    // Stand still; cast, then attack. The cast is a one-round reach with a 2-round cooldown.
    let body = BehaviorBody::parse(&[1, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0]).unwrap();
    let mut archer = unit(AshbornKind::Archer, body, 0, 0);
    archer.cast = Cast { damage: 0, range: 0, aoe: 0, effect: Effect::Reach, aim: Aim::Caster, power: 1, rounds: 1, cooldown: 2 };
    archer.range = 5; // the target is 5 tiles away, in range with or without the reach
    let mut target = dummy(AshbornKind::Warden, 0, 0);
    target.hp = 99;
    let (_, events) = simulate(&[archer], &[target], [0u8; 32], lane(6));
    let per_round: Vec<(usize, usize)> = events
        .split(|event| matches!(event, TraceEvent::Round))
        .take(7)
        .map(|round| {
            let casts = round.iter().filter(|event| matches!(event, TraceEvent::Cast { side: Side::A, .. })).count();
            let attacks = round.iter().filter(|event| matches!(event, TraceEvent::Attack { side: Side::A, .. })).count();
            (casts, attacks)
        })
        .collect();
    // Round 1 casts; rounds 2 and 3 cool down and attack; round 4 casts again.
    assert_eq!(per_round, vec![(1, 0), (0, 1), (0, 1), (1, 0), (0, 1), (0, 1), (1, 0)]);
}

#[test]
fn guard_cast_pushes_two_tiles() {
    let mut fighters = Vec::new();
    push_side(&mut fighters, Side::A, &[dummy(AshbornKind::Guard, 0, 1)], lane(8));
    push_side(&mut fighters, Side::B, &[dummy(AshbornKind::Guard, 0, 0)], lane(8));
    fighters[1].row = 2;
    let mut trace = Trace::recording();
    let mut battle = battle(fighters, lane(8), &[], &mut trace);
    let mut points = 1;
    assert!(battle.try_cast(0, TargetSpec::default(), &mut points));
    assert_eq!(battle.fighters[1].row, 4);
    assert_eq!(trace_text(&trace.events), "C 0 0 1 0 1 5 1 2 0 0 2 0 4\n");
}

#[test]
fn sprint_doubles_the_movement_of_that_round() {
    // Cast first, then charge: the self cast fires at the first step and does not stop the run.
    let sprint_charge = BehaviorBody::parse(&[1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0]).unwrap();
    let (_, events) = simulate(&[unit(AshbornKind::Skirmisher, sprint_charge, 0, 0)], &[dummy(AshbornKind::Guard, 0, 0)], [0u8; 32], lane(MAX_ROWS));
    let first_round = &events[..events.iter().position(|event| matches!(event, TraceEvent::Round)).unwrap()];
    let moves = first_round.iter().filter(|event| matches!(event, TraceEvent::Move { side: Side::A, .. })).count();
    assert_eq!(moves, 6);
    assert!(matches!(
        first_round.iter().find(|event| matches!(event, TraceEvent::Cast { .. })),
        Some(TraceEvent::Cast { effect: Effect::Sprint, amount: 1, rounds: 1, target_side: Side::A, target_index: 0, .. })
    ));
    assert!(first_round.contains(&TraceEvent::Expire { side: Side::A, index: 0, effect: Effect::Sprint }));
}

#[test]
fn reach_lengthens_attacks_for_three_rounds_and_is_not_recast() {
    // Cast, then attack, standing still.
    let body = BehaviorBody::parse(&[1, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0]).unwrap();
    let mut archer = unit(AshbornKind::Archer, body, 0, 0);
    archer.actions = 2;
    let mut target = dummy(AshbornKind::Warden, 0, 0);
    target.hp = 30;
    let (_, events) = simulate(&[archer], &[target], [0u8; 32], lane(6));
    let casts = cast_lines(&events);
    assert!(matches!(casts[0], TraceEvent::Cast { effect: Effect::Reach, amount: 2, rounds: 3, .. }));
    // Distance 5 is out of range 3 but within 3 + 2, so every round lands an arrow.
    let rounds: Vec<usize> = events
        .split(|event| matches!(event, TraceEvent::Round))
        .map(|round| round.iter().filter(|event| matches!(event, TraceEvent::Attack { side: Side::A, .. })).count())
        .collect();
    assert_eq!(&rounds[..4], &[1, 1, 1, 1]);
    let expire = events.iter().position(|event| matches!(event, TraceEvent::Expire { effect: Effect::Reach, .. })).unwrap();
    let rounds_before = events[..expire].iter().filter(|event| matches!(event, TraceEvent::Round)).count();
    assert_eq!(rounds_before, 2, "the reach ends with the third round");
    assert_eq!(casts.len(), 4, "recast every fourth round, once the last one ran out");
}

#[test]
fn taunt_pulls_a_fleeing_target_toward_the_caster() {
    let taunt = BehaviorBody::parse(&[1, 0, 1, 1, 0, 0, 0]).unwrap();
    let flee = BehaviorBody::parse(&[1, 1, 1, 0, 0, 0, 0, 0]).unwrap();
    let mut vanguard = unit(AshbornKind::Vanguard, taunt, 0, 1);
    vanguard.cast.range = 7;
    let mut fleer = unit(AshbornKind::Skirmisher, flee, 0, 1);
    fleer.hp = 40;
    let (_, events) = simulate(&[vanguard], &[fleer], [0u8; 32], lane(8));
    let taunted = events.iter().position(|event| matches!(event, TraceEvent::Cast { .. })).unwrap();
    let toward: Vec<_> = events[taunted..]
        .iter()
        .filter_map(|event| match event {
            TraceEvent::Move { side: Side::B, from_row, to_row, .. } => Some(to_row - from_row),
            _ => None,
        })
        .collect();
    // The skirmisher wants to flee but walks toward the vanguard while taunted.
    assert!(toward.len() >= 3 && toward.iter().take(3).all(|delta| *delta == -1), "{toward:?}");
    assert!(matches!(cast_lines(&events)[0], TraceEvent::Cast { effect: Effect::Taunt, rounds: 2, target_side: Side::B, .. }));
}

#[test]
fn heal_restores_hurt_allies_up_to_their_starting_hp() {
    let heal = BehaviorBody::parse(&[1, 0, 1, 1, 0, 1, 0]).unwrap();
    let mut warden = unit(AshbornKind::Warden, heal, 0, 0);
    warden.speed = 2;
    let mut hurt = dummy(AshbornKind::Guard, 0, 1);
    hurt.hp = 6;
    let mut fighters = Vec::new();
    push_side(&mut fighters, Side::A, &[warden, hurt], lane(6));
    fighters[1].hp = 4;
    fighters[0].hp = 8;
    let mut trace = Trace::recording();
    let mut battle = battle(fighters, lane(6), &[], &mut trace);
    let mut points = 1;
    let lowest_hp = TargetSpec { extremum: Extremum::Lowest, stat: Stat::Hp, side: TargetSide::Enemy };
    assert!(battle.try_cast(0, lowest_hp, &mut points));
    assert_eq!((battle.fighters[0].hp, battle.fighters[1].hp), (9, 6));
    // Nobody is hurt now, so the heal holds and the point is kept.
    points = 1;
    assert!(!battle.try_cast(0, TargetSpec::default(), &mut points));
    assert_eq!(points, 1);
    assert!(matches!(trace.events[0], TraceEvent::Cast { effect: Effect::Heal, amount: 2, target_hp: 6, target_index: 1, .. }));
    assert!(matches!(trace.events[1], TraceEvent::Cast { effect: Effect::Heal, amount: 1, target_hp: 9, target_index: 0, .. }));
    assert_eq!(trace.events.len(), 2);
}

/// A battle in round 0 with an all-zero seed, for calling one engine step directly.
fn battle<'t>(fighters: Vec<Fighter>, board: Geometry, blocked: &[(i32, i32)], trace: &'t mut Trace) -> Battle<'t> {
    Battle::new(fighters, Field::new(board, blocked), [0u8; 32], trace)
}

#[test]
fn deployment_maps_zone_local_rows_onto_opposite_edges() {
    let seed = [9u8; 32];
    let (_, events) = simulate(&[unit(AshbornKind::Guard, behavior_march(), 2, 1)], &[dummy(AshbornKind::Guard, 4, 0)], seed, outpost());
    let start = events.iter().find_map(|event| match event {
        TraceEvent::Move { side: Side::A, from_col, from_row, .. } => Some((*from_col, *from_row)),
        _ => None,
    });
    assert_eq!(start, Some((2, 1)));
    assert!(events.iter().all(|event| !matches!(event, TraceEvent::Move { side: Side::B, .. })));
}

#[test]
fn blocked_tiles_stay_between_the_zones_and_keep_a_path() {
    let seed = [9u8; 32];
    let board = outpost();
    let blocked = blocked_tiles(board, &seed);
    assert!(blocked.len() <= (board.non_zone_tiles() / 5) as usize);
    assert!(!blocked.is_empty());
    for (col, row) in &blocked {
        assert!((0..board.cols).contains(col));
        assert!(*row >= ZONE_DEPTH && *row < board.rows - ZONE_DEPTH);
    }
    assert!(connected(board, &blocked));
    assert_eq!(blocked, blocked_tiles(board, &seed));
    assert_ne!(blocked, blocked_tiles(board, &[1u8; 32]));
}

#[test]
fn a_single_file_choke_is_left_open() {
    let board = Geometry { cols: 1, rows: 9 };
    assert_eq!(board.non_zone_tiles() / 5, 1);
    assert!(blocked_tiles(board, &[4u8; 32]).is_empty());
    assert!(connected(board, &[]));
}

#[test]
fn a_unit_does_not_step_onto_a_blocked_tile() {
    let board = outpost();
    let mut seed = [0u8; 32];
    let mut found = None;
    for byte in 0..255 {
        seed[0] = byte;
        let blocked = blocked_tiles(board, &seed);
        if blocked.contains(&(3, 2)) {
            found = Some((seed, blocked));
            break;
        }
    }
    let (seed, blocked) = found.expect("a seed that blocks column 3, row 2");
    let (winner, events) = simulate(&[unit(AshbornKind::Guard, behavior_march(), 3, 1)], &[unit(AshbornKind::Guard, behavior_march(), 3, 1)], seed, board);
    assert!(blocked.contains(&(3, 2)));
    for event in &events {
        if let TraceEvent::Move { to_col, to_row, from_col, from_row, .. } = event {
            assert!(!blocked.contains(&(*to_col, *to_row)));
            assert!(!blocked.contains(&(*from_col, *from_row)));
        }
    }
    assert!(events.iter().all(|event| !matches!(event, TraceEvent::Move { side: Side::A, from_col: 3, from_row: 1, to_col: 3, to_row: 2, .. })));
    let _ = winner;
}

#[test]
fn movement_spends_the_whole_pool() {
    let approach = BehaviorBody::parse(&[1, 1, 0, 0, 0, 0, 0, 0]).unwrap();
    let (_, events) = simulate(&[unit(AshbornKind::Skirmisher, approach, 0, 0)], &[dummy(AshbornKind::Guard, 0, 0)], [0u8; 32], lane(8));
    let first_defend = events.iter().position(|event| matches!(event, TraceEvent::Defend { side: Side::A, .. })).unwrap();
    let moves: Vec<_> = events[..first_defend]
        .iter()
        .filter_map(|event| match event {
            TraceEvent::Move { side: Side::A, from_row, to_row, .. } => Some((*from_row, *to_row)),
            _ => None,
        })
        .collect();
    assert_eq!(moves, vec![(0, 1), (1, 2), (2, 3)]);

    let approach_then_flee = BehaviorBody::parse(&[2, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0]).unwrap();
    let (_, events) = simulate(&[unit(AshbornKind::Skirmisher, approach_then_flee, 0, 1)], &[dummy(AshbornKind::Guard, 0, 1)], [0u8; 32], lane(5));
    let moves: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            TraceEvent::Move { side: Side::A, from_col, from_row, to_col, to_row, .. } => Some((*from_col, *from_row, *to_col, *to_row)),
            _ => None,
        })
        .collect();
    assert_eq!(moves, vec![(0, 1, 0, 2)]);
}

#[test]
fn charge_keeps_moving_after_an_action() {
    let (_, events) = simulate(&[unit(AshbornKind::Archer, behavior_charge(), 0, 0)], &[dummy(AshbornKind::Guard, 0, 0)], [0u8; 32], lane(5));
    let kinds: Vec<_> = events
        .iter()
        .take(3)
        .map(|event| match event {
            TraceEvent::Move { from_row, to_row, .. } => format!("M{from_row}-{to_row}"),
            TraceEvent::Attack { damage, target_hp, .. } => format!("A{damage}-{target_hp}"),
            other => other.to_line(),
        })
        .collect();
    assert_eq!(kinds, vec!["M0-1".to_string(), "A2-4".to_string(), "M1-2".to_string()]);
}

fn side_moves(events: &[TraceEvent]) -> Vec<(i32, i32, i32, i32)> {
    events
        .iter()
        .filter_map(|event| match event {
            TraceEvent::Move { side: Side::A, from_col, from_row, to_col, to_row, .. } => Some((*from_col, *from_row, *to_col, *to_row)),
            _ => None,
        })
        .collect()
}

fn first_turn_moves(events: &[TraceEvent]) -> Vec<(i32, i32, i32, i32)> {
    let action = events.iter().position(|event| matches!(event, TraceEvent::Attack { side: Side::A, .. } | TraceEvent::Cast { side: Side::A, .. }));
    let end = match action {
        Some(at) if matches!(events.get(at + 1), Some(TraceEvent::Move { side: Side::A, .. })) => at + 2,
        Some(at) => at + 1,
        None => events.len(),
    };
    side_moves(&events[..end])
}

#[test]
fn clear_stop_flag_keeps_moving_after_an_action() {
    let run_then_flee = BehaviorBody::parse(&[2, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0]).unwrap();
    let (_, events) = simulate(&[with_cast(AshbornKind::Archer, run_then_flee, 0, 0, blast(2, 4, 0, 0))], &[dummy(AshbornKind::Guard, 0, 0)], [0u8; 32], lane(5));
    assert_eq!(first_turn_moves(&events), vec![(0, 0, 0, 1), (0, 1, 0, 2)]);
    assert!(events.iter().any(|event| matches!(event, TraceEvent::Attack { side: Side::A, .. })));
}

#[test]
fn march_stops_after_the_action() {
    let (_, events) = simulate(&[unit(AshbornKind::Archer, behavior_march(), 0, 0)], &[dummy(AshbornKind::Guard, 0, 0)], [0u8; 32], lane(5));
    assert_eq!(first_turn_moves(&events), vec![(0, 0, 0, 1)]);
    assert!(events.iter().any(|event| matches!(event, TraceEvent::Attack { side: Side::A, .. })));
}

#[test]
fn kite_second_element_flees() {
    assert_eq!(behavior_kite().elements[0], behavior_march().elements[0]);
    let (_, events) = simulate(&[unit(AshbornKind::Archer, behavior_kite(), 0, 0)], &[dummy(AshbornKind::Guard, 0, 0)], [0u8; 32], lane(5));
    assert_eq!(first_turn_moves(&events), vec![(0, 0, 0, 1), (0, 1, 0, 0)]);
    assert!(events.iter().any(|event| matches!(event, TraceEvent::Attack { side: Side::A, .. })));
}

#[test]
fn a_missed_action_does_not_stop_the_run() {
    let (_, events) = simulate(&[unit(AshbornKind::Archer, behavior_march(), 0, 0)], &[dummy(AshbornKind::Guard, 0, 0)], [0u8; 32], lane(10));
    let first_defend = events.iter().position(|event| matches!(event, TraceEvent::Defend { side: Side::A, .. })).unwrap();
    let moves: Vec<_> = events[..first_defend]
        .iter()
        .filter_map(|event| match event {
            TraceEvent::Move { side: Side::A, from_row, to_row, .. } => Some((*from_row, *to_row)),
            _ => None,
        })
        .collect();
    assert_eq!(moves, vec![(0, 1), (1, 2)]);
    assert!(events[..first_defend].iter().all(|event| !matches!(event, TraceEvent::Attack { .. } | TraceEvent::Cast { .. })));
}

#[test]
fn actions_due_at_the_tile_run_before_the_stop() {
    let run_then_flee = BehaviorBody::parse(&[2, 1, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0]).unwrap();
    let (_, events) = simulate(&[with_cast(AshbornKind::Archer, run_then_flee, 0, 0, blast(2, 4, 0, 0))], &[dummy(AshbornKind::Guard, 0, 0)], [0u8; 32], lane(6));
    assert_eq!(first_turn_moves(&events), vec![(0, 0, 0, 1), (0, 1, 0, 0)]);
    assert!(events.iter().any(|event| matches!(event, TraceEvent::Cast { side: Side::A, .. })));
    assert!(events[..events.iter().position(|event| matches!(event, TraceEvent::Cast { .. })).unwrap()].iter().all(|event| !matches!(event, TraceEvent::Attack { .. })));
}

#[test]
fn action_never_fires_when_nothing_is_in_range() {
    let attack = BehaviorBody::parse(&[1, 0, 1, 0, 0, 0, 0]).unwrap();
    let (_, events) = simulate(&[unit(AshbornKind::Archer, attack, 0, 0)], &[unit(AshbornKind::Archer, attack, 0, 0)], [0u8; 32], lane(10));
    assert!(events.iter().all(|event| !matches!(event, TraceEvent::Attack { .. } | TraceEvent::Cast { .. })));
    assert!(events.iter().any(|event| matches!(event, TraceEvent::Defend { .. })));
}

#[test]
fn leftover_action_points_end_the_turn_defending() {
    let attack = BehaviorBody::parse(&[1, 0, 1, 0, 0, 0, 0]).unwrap();
    let cast = BehaviorBody::parse(&[1, 0, 1, 1, 0, 0, 0]).unwrap();
    let mut reduced = None;
    let mut full = None;
    for byte in 0..64 {
        let mut seed = [0u8; 32];
        seed[0] = byte;
        let (_, events) = simulate(&[unit(AshbornKind::Archer, attack, 0, 0)], &[with_cast(AshbornKind::Archer, cast, 0, 0, blast(2, 4, 0, 0))], seed, lane(5));
        match (&events[0], &events[1]) {
            (TraceEvent::Defend { side: Side::A, .. }, TraceEvent::Cast { damage: 1, target_hp: 2, target_side: Side::A, .. }) => {
                reduced = Some(events);
            }
            (TraceEvent::Cast { damage: 2, target_side: Side::A, .. }, TraceEvent::Defend { side: Side::A, .. }) => {
                full = Some(events);
            }
            _ => {}
        }
        if reduced.is_some() && full.is_some() {
            break;
        }
    }
    assert!(reduced.is_some(), "a defender who acts first reduces the cast to 1");
    assert!(full.is_some(), "a cast before defend still deals 2");
}

#[test]
fn flank_left_steps_perpendicular_to_the_approach() {
    let (_, events) = simulate(&[unit(AshbornKind::Guard, behavior_flank_left(), 1, 1)], &[dummy(AshbornKind::Guard, 1, 1)], [0u8; 32], Geometry { cols: 3, rows: 6 });
    let first = events.iter().find_map(|event| match event {
        TraceEvent::Move { side: Side::A, from_col, from_row, to_col, to_row, .. } => Some((*from_col, *from_row, *to_col, *to_row)),
        _ => None,
    });
    assert_eq!(first, Some((1, 1, 2, 1)));
}

#[test]
fn an_ally_cast_damages_allies_and_not_enemies() {
    let cast = BehaviorBody::parse(&[1, 0, 1, 1, 0, 0, 1]).unwrap();
    let splash = blast(2, 3, 1, 0);
    let board = Geometry { cols: 4, rows: 4 };
    let (_, events) = simulate(
        &[with_cast(AshbornKind::Guard, cast, 0, 0, splash), dummy(AshbornKind::Guard, 2, 1), dummy(AshbornKind::Guard, 3, 1)],
        &[dummy(AshbornKind::Guard, 2, 1)],
        [0u8; 32],
        board,
    );
    let end = events.iter().position(|event| matches!(event, TraceEvent::Round)).unwrap();
    let hits: Vec<_> = events[..end]
        .iter()
        .filter_map(|event| match event {
            TraceEvent::Cast { target_side, target_index, damage, .. } => Some((target_side.id(), *target_index, *damage)),
            _ => None,
        })
        .collect();
    assert_eq!(hits, vec![(0, 1, 2), (0, 2, 2)]);
    assert!(events[..end].iter().all(|event| !matches!(event, TraceEvent::Cast { target_side: Side::B, .. } | TraceEvent::Attack { .. })));
}

#[test]
fn approach_ally_steps_toward_a_friend() {
    let approach = BehaviorBody::parse(&[1, 1, 0, 0, 0, 1, 0, 0]).unwrap();
    let (_, events) = simulate(&[unit(AshbornKind::Guard, approach, 2, 0), dummy(AshbornKind::Guard, 0, 0)], &[dummy(AshbornKind::Guard, 2, 0)], [0u8; 32], outpost());
    let first = events.iter().find_map(|event| match event {
        TraceEvent::Move { side: Side::A, index: 0, from_col, from_row, to_col, to_row, .. } => Some((*from_col, *from_row, *to_col, *to_row)),
        _ => None,
    });
    assert_eq!(first, Some((2, 0, 1, 0)));
}

#[test]
fn catalog_file_matches_stats_and_the_ten_behaviors() {
    let raw = include_str!("../../../content/catalog.json");
    let catalog: serde_json::Value = serde_json::from_str(raw).expect("catalog json");
    let races = catalog["races"].as_array().expect("races");
    let expected = [
        (Race::Ashborn, "Ashborn", "ashborn", AshbornKind::ALL.len()),
        (Race::Rootborn, "Rootborn", "rootborn", RootbornKind::ALL.len()),
        (Race::Deeplings, "Deeplings", "deeplings", DeeplingsKind::ALL.len()),
    ];
    assert_eq!(races.len(), expected.len());
    for ground in catalog["battlegrounds"].as_array().expect("battlegrounds") {
        let board = Geometry { cols: ground["cols"].as_i64().unwrap() as i32, rows: ground["rows"].as_i64().unwrap() as i32 };
        assert!(board.playable(), "{} is not a playable grid", ground["name"]);
    }
    for (entry, (race, name, slug, count)) in races.iter().zip(expected) {
        assert_eq!(entry["id"], race.id());
        assert_eq!(entry["name"], name);
        assert_eq!(entry["slug"], slug);
        let units = entry["units"].as_array().expect("units");
        assert_eq!(units.len(), count);
        for unit in units {
            let id = unit["id"].as_u64().unwrap() as u8;
            let stats = stats_for(race.id(), id).unwrap();
            assert_eq!(stats.cost, unit["cost"].as_u64().unwrap() as u16);
            assert_eq!(stats.hp, unit["hp"].as_i64().unwrap() as i32);
            assert_eq!(stats.atk, unit["atk"].as_i64().unwrap() as i32);
            assert_eq!(stats.range, unit["range"].as_i64().unwrap() as i32);
            assert_eq!(stats.speed, unit["speed"].as_i64().unwrap() as i32);
            assert_eq!(stats.actions, unit["actions"].as_i64().unwrap() as i32);
            let cast = &unit["cast"];
            assert_eq!(stats.cast.damage, cast["damage"].as_u64().unwrap() as u8);
            assert_eq!(stats.cast.range, cast["range"].as_u64().unwrap() as u8);
            assert_eq!(stats.cast.aoe, cast["aoe"].as_u64().unwrap() as u8);
            let effect = catalog_id(
                &[("none", Effect::None), ("push", Effect::Push), ("sprint", Effect::Sprint), ("reach", Effect::Reach), ("taunt", Effect::Taunt), ("heal", Effect::Heal)],
                cast["effect"].as_str().unwrap(),
            );
            let aim = catalog_id(&[("chosen", Aim::Chosen), ("foe", Aim::Foe), ("ally", Aim::Ally), ("self", Aim::Caster)], cast["aim"].as_str().unwrap());
            assert_eq!(stats.cast.effect, effect);
            assert_eq!(stats.cast.aim, aim);
            assert_eq!(stats.cast.power, cast["power"].as_u64().unwrap() as u8);
            assert_eq!(stats.cast.rounds, cast["rounds"].as_u64().unwrap() as u8);
            assert_eq!(stats.cast.cooldown, cast["cooldown"].as_u64().unwrap() as u8);
        }
    }
    let behaviors = catalog["behaviors"].as_array().expect("behaviors");
    let names: Vec<_> = behaviors.iter().map(|item| item["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["March", "Charge", "Kite", "Flank left", "Flank right", "March cast", "Charge cast", "Kite cast", "Flank left cast", "Flank right cast",]);
    let expected = [
        behavior_march(),
        behavior_charge(),
        behavior_kite(),
        behavior_flank_left(),
        behavior_flank_right(),
        behavior_march_cast(),
        behavior_charge_cast(),
        behavior_kite_cast(),
        behavior_flank_left_cast(),
        behavior_flank_right_cast(),
    ];
    for (behavior, body) in behaviors.iter().zip(expected) {
        assert_eq!(encode_catalog_behavior(behavior), body.canonical_bytes(), "{}", behavior["name"]);
    }
}

fn catalog_id<T: Copy>(table: &[(&str, T)], name: &str) -> T {
    table.iter().find(|(key, _)| *key == name).unwrap_or_else(|| panic!("unknown {name}")).1
}

fn encode_catalog_behavior(behavior: &serde_json::Value) -> Vec<u8> {
    let elements = behavior["elements"].as_array().unwrap();
    let mut out = vec![elements.len() as u8];
    for element in elements {
        if element["movement"].is_null() {
            out.push(0);
        } else {
            let movement = &element["movement"];
            out.extend_from_slice(&[
                1,
                catalog_id(&[("approach", 0), ("flee", 1), ("flank-left", 2), ("flank-right", 3)], movement["kind"].as_str().unwrap()),
                catalog_id(&[("lowest", 0), ("highest", 1)], movement["extremum"].as_str().unwrap()),
                catalog_id(&[("distance", 0), ("hp", 1), ("atk", 2)], movement["stat"].as_str().unwrap()),
                catalog_id(&[("enemy", 0), ("ally", 1)], movement["side"].as_str().unwrap()),
                u8::from(movement["stop"].as_bool().unwrap()),
            ]);
        }
        let actions = element["actions"].as_array().unwrap();
        out.push(actions.len() as u8);
        for action in actions {
            out.extend_from_slice(&[
                catalog_id(&[("attack", 0), ("cast", 1)], action["type"].as_str().unwrap()),
                catalog_id(&[("lowest", 0), ("highest", 1)], action["extremum"].as_str().unwrap()),
                catalog_id(&[("distance", 0), ("hp", 1), ("atk", 2)], action["stat"].as_str().unwrap()),
                catalog_id(&[("enemy", 0), ("ally", 1)], action["side"].as_str().unwrap()),
            ]);
        }
    }
    out
}

#[test]
fn playable_boards_stay_within_the_row_and_tile_caps() {
    for (cols, rows) in [(12, 10), (30, 4), (15, 8), (20, 6), (1, 4), (30, 4)] {
        assert!(Geometry { cols, rows }.playable(), "{cols} x {rows}");
    }
    for (cols, rows) in [(13, 10), (12, 11), (11, 11), (8, 15), (6, 20), (32, 32), (33, 4), (0, 4), (4, 3)] {
        assert!(!Geometry { cols, rows }.playable(), "{cols} x {rows}");
    }
}
