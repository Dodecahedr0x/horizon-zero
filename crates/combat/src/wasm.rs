//! The browser and node entry points: JSON in, JSON out.

use crate::{behavior_hash, blocked_tiles, simulate, Aim, BehaviorBody, Cast, Effect, Geometry, Side, SnapshotUnit, TraceEvent};
use wasm_bindgen::prelude::*;

/// `{"error": message}`, escaped by serde so any message stays valid JSON.
fn error(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

#[derive(serde::Deserialize)]
struct InputCast {
    damage: u8,
    range: u8,
    aoe: u8,
    #[serde(default)]
    effect: u8,
    #[serde(default)]
    aim: u8,
    #[serde(default)]
    power: u8,
    #[serde(default)]
    rounds: u8,
    #[serde(default)]
    cooldown: u8,
}

#[derive(serde::Deserialize)]
struct InputUnit {
    kind: u8,
    body: Vec<u8>,
    col: u8,
    row: u8,
    cost: u16,
    hp: i32,
    atk: i32,
    range: i32,
    speed: i32,
    actions: i32,
    cast: InputCast,
}

#[derive(serde::Deserialize)]
struct Input {
    cols: i32,
    rows: i32,
    a: Vec<InputUnit>,
    b: Vec<InputUnit>,
    seed: Vec<u8>,
}

/// Bound for every input stat. The catalog tops out under 100; an unbounded stat overflows the
/// engine's arithmetic or stalls the browser on a huge speed.
const MAX_STAT: i32 = 1000;

/// An unknown cast effect or aim byte, or a stat outside `0..=MAX_STAT`, is an input error, not a silent default.
fn convert(units: &[InputUnit]) -> Result<Vec<SnapshotUnit>, String> {
    units
        .iter()
        .map(|unit| {
            for (name, value) in [("hp", unit.hp), ("atk", unit.atk), ("range", unit.range), ("speed", unit.speed), ("actions", unit.actions)] {
                if !(0..=MAX_STAT).contains(&value) {
                    return Err(format!("{name} {value} is outside 0..={MAX_STAT}"));
                }
            }
            Ok(SnapshotUnit {
                kind: unit.kind,
                behavior: BehaviorBody::parse(&unit.body).unwrap_or_default(),
                col: unit.col,
                row: unit.row,
                cost: unit.cost,
                hp: unit.hp,
                atk: unit.atk,
                range: unit.range,
                speed: unit.speed,
                actions: unit.actions,
                cast: Cast {
                    damage: unit.cast.damage,
                    range: unit.cast.range,
                    aoe: unit.cast.aoe,
                    effect: Effect::from_u8(unit.cast.effect).ok_or_else(|| format!("unknown cast effect {}", unit.cast.effect))?,
                    aim: Aim::from_u8(unit.cast.aim).ok_or_else(|| format!("unknown cast aim {}", unit.cast.aim))?,
                    power: unit.cast.power,
                    rounds: unit.cast.rounds,
                    cooldown: unit.cast.cooldown,
                },
            })
        })
        .collect()
}

#[wasm_bindgen]
pub fn simulate_json(input: &str) -> String {
    let parsed: Input = match serde_json::from_str(input) {
        Ok(value) => value,
        Err(err) => return error(&err.to_string()),
    };
    if parsed.seed.len() != 32 {
        return error("seed must be 32 bytes");
    }
    let board = Geometry { cols: parsed.cols, rows: parsed.rows };
    if !board.playable() {
        return error("board is not playable");
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&parsed.seed);
    let sides = convert(&parsed.a).and_then(|a| Ok((a, convert(&parsed.b)?)));
    let (side_a, side_b) = match sides {
        Ok(sides) => sides,
        Err(err) => return error(&err),
    };
    let (winner, events) = simulate(&side_a, &side_b, seed, board);
    let lines: Vec<String> = events.iter().copied().map(TraceEvent::to_line).collect();
    serde_json::json!({
        "winner": winner.map(Side::id),
        "lines": lines,
    })
    .to_string()
}

#[wasm_bindgen]
pub fn blocked_json(cols: i32, rows: i32, seed: &[u8]) -> String {
    if seed.len() != 32 {
        return error("seed must be 32 bytes");
    }
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(seed);
    let tiles = blocked_tiles(Geometry { cols, rows }, &bytes);
    serde_json::json!(tiles.into_iter().map(|(col, row)| serde_json::json!({ "col": col, "row": row })).collect::<Vec<_>>()).to_string()
}

#[wasm_bindgen]
pub fn hash_behavior(body: &[u8]) -> String {
    behavior_hash(body).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::simulate_json;

    fn input(speed: i64) -> String {
        let unit = format!(r#"{{"kind":0,"body":[],"col":0,"row":0,"cost":1,"hp":10,"atk":5,"range":1,"speed":{speed},"actions":1,"cast":{{"damage":0,"range":0,"aoe":0}}}}"#);
        format!(r#"{{"cols":4,"rows":6,"a":[{unit}],"b":[],"seed":{:?}}}"#, [0u8; 32])
    }

    #[test]
    fn stats_outside_the_bound_are_input_errors() {
        assert!(!simulate_json(&input(1000)).contains("error"));
        assert!(simulate_json(&input(1001)).contains("speed 1001 is outside"));
        assert!(simulate_json(&input(-1)).contains("speed -1 is outside"));
        assert!(simulate_json(&input(i32::MAX as i64)).contains("error"));
    }
}
