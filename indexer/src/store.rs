//! SQLite rows for behaviors, battlegrounds, armies, battles, and users.
//!
//! Timestamps are unix seconds from RPC block time. Date columns are the UTC
//! day `YYYY-MM-DD`. A missing block time stays null. It is never invented.

use std::path::Path;

use chrono::{DateTime, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::decode::{
    ArmyAccount, ArmyUnit, BattleAccount, BattleUnit, BattlegroundAccount, BehaviorAccount,
    HorizonAccount,
};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS behaviors (
    pubkey TEXT PRIMARY KEY,
    creator TEXT NOT NULL,
    body_json TEXT NOT NULL,
    element_count INTEGER NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER,
    updated_at INTEGER,
    created_date TEXT,
    updated_date TEXT
);
CREATE INDEX IF NOT EXISTS behaviors_created_date ON behaviors(created_date);
CREATE INDEX IF NOT EXISTS behaviors_updated_date ON behaviors(updated_date);

CREATE TABLE IF NOT EXISTS battlegrounds (
    pubkey TEXT PRIMARY KEY,
    battleground_id INTEGER NOT NULL,
    budget INTEGER NOT NULL,
    stake TEXT NOT NULL,
    cols INTEGER NOT NULL,
    rows INTEGER NOT NULL,
    zone_depth INTEGER NOT NULL,
    queue_json TEXT NOT NULL,
    match_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS armies (
    pubkey TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    battleground TEXT NOT NULL,
    race INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    status INTEGER NOT NULL,
    units_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
    pubkey TEXT PRIMARY KEY,
    battleground TEXT NOT NULL,
    army_a TEXT NOT NULL,
    army_b TEXT NOT NULL,
    player_a TEXT NOT NULL,
    player_b TEXT NOT NULL,
    stake TEXT NOT NULL,
    seq INTEGER NOT NULL,
    cols INTEGER NOT NULL,
    rows INTEGER NOT NULL,
    units_a TEXT NOT NULL,
    units_b TEXT NOT NULL,
    status INTEGER NOT NULL,
    seed TEXT NOT NULL,
    outcome INTEGER NOT NULL,
    open_at INTEGER,
    resolved_at INTEGER,
    open_date TEXT,
    resolved_date TEXT
);
CREATE INDEX IF NOT EXISTS matches_open_date ON matches(open_date);
CREATE INDEX IF NOT EXISTS matches_resolved_date ON matches(resolved_date);

CREATE TABLE IF NOT EXISTS users (
    wallet TEXT PRIMARY KEY,
    first_seen INTEGER,
    last_seen INTEGER,
    first_date TEXT,
    last_date TEXT
);
CREATE INDEX IF NOT EXISTS users_first_date ON users(first_date);
CREATE INDEX IF NOT EXISTS users_last_date ON users(last_date);
";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DayRange {
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorOut {
    pub pubkey: String,
    pub creator: String,
    pub body: Vec<u8>,
    pub element_count: u16,
    pub summary: String,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub created_date: Option<String>,
    pub updated_date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattlegroundOut {
    pub pubkey: String,
    pub battleground_id: u8,
    pub budget: u16,
    pub stake: String,
    pub cols: u8,
    pub rows: u8,
    pub zone_depth: u8,
    pub queue: Vec<String>,
    pub match_seq: u64,
}

/// Game-wide numbers for the landing page. Lamport sums are decimal strings, as stakes are.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatsOut {
    /// Battles settled, with a winner or a draw.
    pub battles_fought: u64,
    /// Battles settled in the 24 hours before `generated_at`.
    pub battles_today: u64,
    /// Battles opened and not yet settled.
    pub battles_awaiting: u64,
    pub draws: u64,
    /// Wallets that have created a behavior, an army, or a battle.
    pub players: u64,
    pub behaviors: u64,
    /// Armies waiting in a battleground queue for a foe.
    pub armies_locked: u64,
    /// Both stakes of every battle opened, settled or not.
    pub staked_lamports: String,
    pub battlegrounds: Vec<GroundStatsOut>,
    pub generated_at: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroundStatsOut {
    pub battleground_id: u8,
    pub locked: u64,
    pub battles_fought: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CastOut {
    pub damage: u8,
    pub range: u8,
    pub aoe: u8,
    pub effect: u8,
    pub aim: u8,
    pub power: u8,
    pub rounds: u8,
    pub cooldown: u8,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ArmyUnitOut {
    pub kind: u8,
    pub behavior: String,
    pub body: Vec<u8>,
    pub col: u8,
    pub row: u8,
    pub cost: u16,
    pub hp: u8,
    pub atk: u8,
    pub range: u8,
    pub speed: u8,
    pub actions: u8,
    pub cast: CastOut,
    pub race: u8,
}

#[derive(Debug, Serialize)]
pub struct ArmyOut {
    pub pubkey: String,
    pub owner: String,
    pub battleground: String,
    pub race: u8,
    pub idx: u32,
    pub status: u8,
    pub units: Vec<ArmyUnitOut>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BattleUnitOut {
    pub kind: u8,
    pub body: Vec<u8>,
    pub col: u8,
    pub row: u8,
    pub cost: u16,
    pub hp: u8,
    pub atk: u8,
    pub range: u8,
    pub speed: u8,
    pub actions: u8,
    pub cast: CastOut,
    pub race: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleOut {
    pub pubkey: String,
    pub battleground: String,
    pub army_a: String,
    pub army_b: String,
    pub player_a: String,
    pub player_b: String,
    pub stake: String,
    pub seq: u64,
    pub cols: u8,
    pub rows: u8,
    pub units_a: Vec<BattleUnitOut>,
    pub units_b: Vec<BattleUnitOut>,
    pub status: u8,
    pub seed: String,
    pub outcome: u8,
    pub open_at: Option<i64>,
    pub resolved_at: Option<i64>,
    pub open_date: Option<String>,
    pub resolved_date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserOut {
    pub wallet: String,
    pub first_seen: Option<i64>,
    pub last_seen: Option<i64>,
    pub first_date: Option<String>,
    pub last_date: Option<String>,
    pub behavior_count: i64,
    pub army_count: i64,
    pub battle_count: i64,
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|err| {
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error {
                        code: rusqlite::ffi::ErrorCode::CannotOpen,
                        extended_code: 0,
                    },
                    Some(err.to_string()),
                )
            })?;
        }
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let columns = table_columns(conn, "behaviors")?;
    if !columns.is_empty() && !columns.iter().any(|name| name == "element_count") {
        conn.execute_batch(
            "DROP TABLE IF EXISTS behaviors;
             DROP TABLE IF EXISTS battlegrounds;
             DROP TABLE IF EXISTS armies;
             DROP TABLE IF EXISTS matches;
             DROP TABLE IF EXISTS users;",
        )?;
    }
    conn.execute_batch(SCHEMA)
}

fn table_columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect()
}

pub fn utc_day(unix: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(unix, 0).map(|time| time.format("%Y-%m-%d").to_string())
}

pub fn record(
    conn: &Connection,
    pubkey: &str,
    account: &HorizonAccount,
    unix: Option<i64>,
) -> rusqlite::Result<()> {
    match account {
        HorizonAccount::Behavior(behavior) => record_behavior(conn, pubkey, behavior, unix)?,
        HorizonAccount::Battleground(ground) => record_battleground(conn, pubkey, ground)?,
        HorizonAccount::Army(army) => record_army(conn, pubkey, army)?,
        HorizonAccount::Battle(battle) => record_battle(conn, pubkey, battle, unix)?,
    }
    for wallet in crate::decode::users_of(account) {
        touch_user(conn, &wallet, unix)?;
    }
    Ok(())
}

fn record_behavior(
    conn: &Connection,
    pubkey: &str,
    behavior: &BehaviorAccount,
    unix: Option<i64>,
) -> rusqlite::Result<()> {
    let existing = conn
        .query_row(
            "SELECT created_at, updated_at FROM behaviors WHERE pubkey = ?1",
            [pubkey],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()?;
    let (created_at, updated_at) = match existing {
        Some((created, updated)) => (earliest(created, unix), latest(updated, unix)),
        None => (unix, unix),
    };
    conn.execute(
        "INSERT INTO behaviors (
            pubkey, creator, body_json, element_count, summary,
            created_at, updated_at, created_date, updated_date
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(pubkey) DO UPDATE SET
            creator = excluded.creator,
            body_json = excluded.body_json,
            element_count = excluded.element_count,
            summary = excluded.summary,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            created_date = excluded.created_date,
            updated_date = excluded.updated_date",
        params![
            pubkey,
            behavior.creator,
            serde_json::to_string(&behavior.body).unwrap_or_else(|_| "[]".to_string()),
            behavior.element_count,
            behavior.summary,
            created_at,
            updated_at,
            created_at.and_then(utc_day),
            updated_at.and_then(utc_day),
        ],
    )?;
    Ok(())
}

fn record_battleground(
    conn: &Connection,
    pubkey: &str,
    ground: &BattlegroundAccount,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO battlegrounds (
            pubkey, battleground_id, budget, stake, cols, rows, zone_depth, queue_json, match_seq
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(pubkey) DO UPDATE SET
            battleground_id = excluded.battleground_id,
            budget = excluded.budget,
            stake = excluded.stake,
            cols = excluded.cols,
            rows = excluded.rows,
            zone_depth = excluded.zone_depth,
            queue_json = excluded.queue_json,
            match_seq = excluded.match_seq",
        params![
            pubkey,
            ground.battleground_id,
            ground.budget,
            ground.stake.to_string(),
            ground.cols,
            ground.rows,
            ground.zone_depth,
            serde_json::to_string(&ground.queue).unwrap_or_else(|_| "[]".to_string()),
            ground.match_seq,
        ],
    )?;
    Ok(())
}

fn record_army(conn: &Connection, pubkey: &str, army: &ArmyAccount) -> rusqlite::Result<()> {
    let units: Vec<ArmyUnitOut> = army.units.iter().map(|unit| army_unit_out(unit, army.race)).collect();
    conn.execute(
        "INSERT INTO armies (pubkey, owner, battleground, race, idx, status, units_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(pubkey) DO UPDATE SET
            owner = excluded.owner,
            battleground = excluded.battleground,
            race = excluded.race,
            idx = excluded.idx,
            status = excluded.status,
            units_json = excluded.units_json",
        params![
            pubkey,
            army.owner,
            army.battleground,
            army.race,
            army.index,
            army.status,
            serde_json::to_string(&units).unwrap_or_else(|_| "[]".to_string()),
        ],
    )?;
    Ok(())
}

fn record_battle(
    conn: &Connection,
    pubkey: &str,
    battle: &BattleAccount,
    unix: Option<i64>,
) -> rusqlite::Result<()> {
    let existing = conn
        .query_row(
            "SELECT open_at, resolved_at FROM matches WHERE pubkey = ?1",
            [pubkey],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()?;
    let (mut open_at, mut resolved_at) = existing.unwrap_or((None, None));
    // Status 0 is Awaiting, 1 is Resolved. The first observation of each state
    // supplies that timestamp. A later write does not replace it.
    if battle.status == 0 && open_at.is_none() {
        open_at = unix;
    }
    if battle.status == 1 && resolved_at.is_none() {
        resolved_at = unix;
    }
    let units_a: Vec<BattleUnitOut> = battle.units_a.iter().map(|unit| battle_unit_out(unit, battle.race_a)).collect();
    let units_b: Vec<BattleUnitOut> = battle.units_b.iter().map(|unit| battle_unit_out(unit, battle.race_b)).collect();
    conn.execute(
        "INSERT INTO matches (
            pubkey, battleground, army_a, army_b, player_a, player_b, stake, seq,
            cols, rows, units_a, units_b, status, seed, outcome,
            open_at, resolved_at, open_date, resolved_date
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
         ON CONFLICT(pubkey) DO UPDATE SET
            battleground = excluded.battleground,
            army_a = excluded.army_a,
            army_b = excluded.army_b,
            player_a = excluded.player_a,
            player_b = excluded.player_b,
            stake = excluded.stake,
            seq = excluded.seq,
            cols = excluded.cols,
            rows = excluded.rows,
            units_a = excluded.units_a,
            units_b = excluded.units_b,
            status = excluded.status,
            seed = excluded.seed,
            outcome = excluded.outcome,
            open_at = excluded.open_at,
            resolved_at = excluded.resolved_at,
            open_date = excluded.open_date,
            resolved_date = excluded.resolved_date",
        params![
            pubkey,
            battle.battleground,
            battle.army_a,
            battle.army_b,
            battle.player_a,
            battle.player_b,
            battle.stake.to_string(),
            battle.seq,
            battle.cols,
            battle.rows,
            serde_json::to_string(&units_a).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(&units_b).unwrap_or_else(|_| "[]".to_string()),
            battle.status,
            battle.seed,
            battle.outcome,
            open_at,
            resolved_at,
            open_at.and_then(utc_day),
            resolved_at.and_then(utc_day),
        ],
    )?;
    Ok(())
}

fn touch_user(conn: &Connection, wallet: &str, unix: Option<i64>) -> rusqlite::Result<()> {
    let existing = conn
        .query_row(
            "SELECT first_seen, last_seen FROM users WHERE wallet = ?1",
            [wallet],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()?;
    let (first_seen, last_seen) = match existing {
        Some((first, last)) => (earliest(first, unix), latest(last, unix)),
        None => (unix, unix),
    };
    conn.execute(
        "INSERT INTO users (wallet, first_seen, last_seen, first_date, last_date)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(wallet) DO UPDATE SET
            first_seen = excluded.first_seen,
            last_seen = excluded.last_seen,
            first_date = excluded.first_date,
            last_date = excluded.last_date",
        params![
            wallet,
            first_seen,
            last_seen,
            first_seen.and_then(utc_day),
            last_seen.and_then(utc_day),
        ],
    )?;
    Ok(())
}

fn earliest(existing: Option<i64>, incoming: Option<i64>) -> Option<i64> {
    match (existing, incoming) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn latest(existing: Option<i64>, incoming: Option<i64>) -> Option<i64> {
    match (existing, incoming) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn cast_out(unit: [u8; 8]) -> CastOut {
    let [damage, range, aoe, effect, aim, power, rounds, cooldown] = unit;
    CastOut { damage, range, aoe, effect, aim, power, rounds, cooldown }
}

fn army_unit_out(unit: &ArmyUnit, race: u8) -> ArmyUnitOut {
    ArmyUnitOut {
        kind: unit.kind,
        behavior: unit.behavior.clone(),
        body: unit.body.clone(),
        col: unit.col,
        row: unit.row,
        cost: unit.cost,
        hp: unit.hp,
        atk: unit.atk,
        range: unit.range,
        speed: unit.speed,
        actions: unit.actions,
        cast: cast_out([
            unit.cast_damage,
            unit.cast_range,
            unit.cast_aoe,
            unit.cast_effect,
            unit.cast_aim,
            unit.cast_power,
            unit.cast_rounds,
            unit.cast_cooldown,
        ]),
        race,
    }
}

fn battle_unit_out(unit: &BattleUnit, race: u8) -> BattleUnitOut {
    BattleUnitOut {
        kind: unit.kind,
        body: unit.body.clone(),
        col: unit.col,
        row: unit.row,
        cost: unit.cost,
        hp: unit.hp,
        atk: unit.atk,
        range: unit.range,
        speed: unit.speed,
        actions: unit.actions,
        cast: cast_out([
            unit.cast_damage,
            unit.cast_range,
            unit.cast_aoe,
            unit.cast_effect,
            unit.cast_aim,
            unit.cast_power,
            unit.cast_rounds,
            unit.cast_cooldown,
        ]),
        race,
    }
}

pub fn behaviors(conn: &Connection, range: &DayRange) -> rusqlite::Result<Vec<BehaviorOut>> {
    let (filter, args) = behavior_filter(range);
    let sql = format!(
        "SELECT pubkey, creator, body_json, element_count, summary, created_at, updated_at, created_date, updated_date
         FROM behaviors{filter} ORDER BY pubkey"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |row| {
        let body_json: String = row.get(2)?;
        Ok(BehaviorOut {
            pubkey: row.get(0)?,
            creator: row.get(1)?,
            body: serde_json::from_str(&body_json).unwrap_or_default(),
            element_count: row.get(3)?,
            summary: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
            created_date: row.get(7)?,
            updated_date: row.get(8)?,
        })
    })?;
    rows.collect()
}

pub fn battlegrounds(conn: &Connection) -> rusqlite::Result<Vec<BattlegroundOut>> {
    let mut stmt = conn.prepare(
        "SELECT pubkey, battleground_id, budget, stake, cols, rows, zone_depth, queue_json, match_seq
         FROM battlegrounds ORDER BY battleground_id",
    )?;
    let rows = stmt.query_map([], |row| {
        let queue_json: String = row.get(7)?;
        Ok(BattlegroundOut {
            pubkey: row.get(0)?,
            battleground_id: row.get(1)?,
            budget: row.get(2)?,
            stake: row.get(3)?,
            cols: row.get(4)?,
            rows: row.get(5)?,
            zone_depth: row.get(6)?,
            queue: serde_json::from_str(&queue_json).unwrap_or_default(),
            match_seq: row.get(8)?,
        })
    })?;
    rows.collect()
}

pub fn stats(conn: &Connection, now: i64) -> rusqlite::Result<StatsOut> {
    let count = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> rusqlite::Result<u64> {
        conn.query_row(sql, params, |row| row.get::<_, i64>(0)).map(|value| value.max(0) as u64)
    };
    let mut staked: u128 = 0;
    {
        let mut stmt = conn.prepare("SELECT stake FROM matches")?;
        let stakes = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for stake in stakes {
            staked += 2 * stake?.parse::<u128>().unwrap_or(0);
        }
    }
    let mut grounds = Vec::new();
    let mut locked_total = 0;
    {
        let mut stmt = conn.prepare(
            "SELECT g.battleground_id, g.queue_json,
                    (SELECT COUNT(*) FROM matches m WHERE m.battleground = g.pubkey AND m.status = 1)
             FROM battlegrounds g ORDER BY g.battleground_id",
        )?;
        let rows = stmt.query_map([], |row| {
            let queue: String = row.get(1)?;
            Ok((row.get::<_, u8>(0)?, queue, row.get::<_, i64>(2)?))
        })?;
        for row in rows {
            let (battleground_id, queue, fought) = row?;
            let locked = serde_json::from_str::<Vec<String>>(&queue).map(|keys| keys.len()).unwrap_or(0) as u64;
            locked_total += locked;
            grounds.push(GroundStatsOut { battleground_id, locked, battles_fought: fought.max(0) as u64 });
        }
    }
    Ok(StatsOut {
        battles_fought: count("SELECT COUNT(*) FROM matches WHERE status = 1", &[])?,
        battles_today: count(
            "SELECT COUNT(*) FROM matches WHERE status = 1 AND resolved_at >= ?1",
            &[&(now - 86_400)],
        )?,
        battles_awaiting: count("SELECT COUNT(*) FROM matches WHERE status != 1", &[])?,
        draws: count("SELECT COUNT(*) FROM matches WHERE status = 1 AND outcome = 3", &[])?,
        players: count("SELECT COUNT(*) FROM users", &[])?,
        behaviors: count("SELECT COUNT(*) FROM behaviors", &[])?,
        armies_locked: locked_total,
        staked_lamports: staked.to_string(),
        battlegrounds: grounds,
        generated_at: now,
    })
}

pub fn armies(conn: &Connection, owner: &str) -> rusqlite::Result<Vec<ArmyOut>> {
    let mut stmt = conn.prepare(
        "SELECT pubkey, owner, battleground, race, idx, status, units_json
         FROM armies WHERE owner = ?1 ORDER BY idx",
    )?;
    let rows = stmt.query_map([owner], army_row)?;
    rows.collect()
}

pub fn army(conn: &Connection, pubkey: &str) -> rusqlite::Result<Option<ArmyOut>> {
    conn.query_row(
        "SELECT pubkey, owner, battleground, race, idx, status, units_json FROM armies WHERE pubkey = ?1",
        [pubkey],
        army_row,
    )
    .optional()
}

/// Every stored army key, for the closed-army prune.
pub fn army_keys(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT pubkey FROM armies")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    rows.collect()
}

/// Drops armies that `close_army` removed from the chain.
pub fn forget_armies(conn: &Connection, keys: &[String]) -> rusqlite::Result<usize> {
    let mut removed = 0;
    for key in keys {
        removed += conn.execute("DELETE FROM armies WHERE pubkey = ?1", [key])?;
    }
    Ok(removed)
}

fn army_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArmyOut> {
    let units_json: String = row.get(6)?;
    Ok(ArmyOut {
        pubkey: row.get(0)?,
        owner: row.get(1)?,
        battleground: row.get(2)?,
        race: row.get(3)?,
        idx: row.get(4)?,
        status: row.get(5)?,
        units: serde_json::from_str(&units_json).unwrap_or_default(),
    })
}

pub fn battles(conn: &Connection, range: &DayRange) -> rusqlite::Result<Vec<BattleOut>> {
    let (filter, args) = battle_filter(range);
    let sql = format!(
        "SELECT pubkey, battleground, army_a, army_b, player_a, player_b, stake, seq,
                cols, rows, units_a, units_b, status, seed, outcome,
                open_at, resolved_at, open_date, resolved_date
         FROM matches{filter} ORDER BY seq DESC, pubkey"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), battle_row)?;
    rows.collect()
}

pub fn battle(conn: &Connection, pubkey: &str) -> rusqlite::Result<Option<BattleOut>> {
    conn.query_row(
        "SELECT pubkey, battleground, army_a, army_b, player_a, player_b, stake, seq,
                cols, rows, units_a, units_b, status, seed, outcome,
                open_at, resolved_at, open_date, resolved_date
         FROM matches WHERE pubkey = ?1",
        [pubkey],
        battle_row,
    )
    .optional()
}

fn battle_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BattleOut> {
    let units_a: String = row.get(10)?;
    let units_b: String = row.get(11)?;
    Ok(BattleOut {
        pubkey: row.get(0)?,
        battleground: row.get(1)?,
        army_a: row.get(2)?,
        army_b: row.get(3)?,
        player_a: row.get(4)?,
        player_b: row.get(5)?,
        stake: row.get(6)?,
        seq: row.get(7)?,
        cols: row.get(8)?,
        rows: row.get(9)?,
        units_a: serde_json::from_str(&units_a).unwrap_or_default(),
        units_b: serde_json::from_str(&units_b).unwrap_or_default(),
        status: row.get(12)?,
        seed: row.get(13)?,
        outcome: row.get(14)?,
        open_at: row.get(15)?,
        resolved_at: row.get(16)?,
        open_date: row.get(17)?,
        resolved_date: row.get(18)?,
    })
}

pub fn battleground(conn: &Connection, pubkey: &str) -> rusqlite::Result<Option<BattlegroundOut>> {
    conn.query_row(
        "SELECT pubkey, battleground_id, budget, stake, cols, rows, zone_depth, queue_json, match_seq
         FROM battlegrounds WHERE pubkey = ?1",
        [pubkey],
        |row| {
            let queue_json: String = row.get(7)?;
            Ok(BattlegroundOut {
                pubkey: row.get(0)?,
                battleground_id: row.get(1)?,
                budget: row.get(2)?,
                stake: row.get(3)?,
                cols: row.get(4)?,
                rows: row.get(5)?,
                zone_depth: row.get(6)?,
                queue: serde_json::from_str(&queue_json).unwrap_or_default(),
                match_seq: row.get(8)?,
            })
        },
    )
    .optional()
}

pub fn users(conn: &Connection, range: &DayRange) -> rusqlite::Result<Vec<UserOut>> {
    let (filter, args) = user_filter(range);
    let sql = format!(
        "SELECT wallet, first_seen, last_seen, first_date, last_date,
            (SELECT COUNT(*) FROM behaviors WHERE creator = users.wallet),
            (SELECT COUNT(*) FROM armies WHERE owner = users.wallet),
            (SELECT COUNT(*) FROM matches WHERE player_a = users.wallet OR player_b = users.wallet)
         FROM users{filter} ORDER BY wallet"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |row| {
        Ok(UserOut {
            wallet: row.get(0)?,
            first_seen: row.get(1)?,
            last_seen: row.get(2)?,
            first_date: row.get(3)?,
            last_date: row.get(4)?,
            behavior_count: row.get(5)?,
            army_count: row.get(6)?,
            battle_count: row.get(7)?,
        })
    })?;
    rows.collect()
}

fn behavior_filter(range: &DayRange) -> (String, Vec<String>) {
    match (&range.from, &range.to) {
        (None, None) => (String::new(), Vec::new()),
        (Some(from), Some(to)) => (
            " WHERE ((created_date >= ?1 AND created_date <= ?2) OR (updated_date >= ?1 AND updated_date <= ?2))".into(),
            vec![from.clone(), to.clone()],
        ),
        (Some(from), None) => (
            " WHERE (created_date >= ?1 OR updated_date >= ?1)".into(),
            vec![from.clone()],
        ),
        (None, Some(to)) => (
            " WHERE (created_date <= ?1 OR updated_date <= ?1)".into(),
            vec![to.clone()],
        ),
    }
}

fn battle_filter(range: &DayRange) -> (String, Vec<String>) {
    match (&range.from, &range.to) {
        (None, None) => (String::new(), Vec::new()),
        (Some(from), Some(to)) => (
            " WHERE ((open_date >= ?1 AND open_date <= ?2) OR (resolved_date >= ?1 AND resolved_date <= ?2))".into(),
            vec![from.clone(), to.clone()],
        ),
        (Some(from), None) => (
            " WHERE (open_date >= ?1 OR resolved_date >= ?1)".into(),
            vec![from.clone()],
        ),
        (None, Some(to)) => (
            " WHERE ((open_date IS NOT NULL AND open_date <= ?1) OR (resolved_date IS NOT NULL AND resolved_date <= ?1))".into(),
            vec![to.clone()],
        ),
    }
}

fn user_filter(range: &DayRange) -> (String, Vec<String>) {
    match (&range.from, &range.to) {
        (None, None) => (String::new(), Vec::new()),
        (Some(from), Some(to)) => (
            " WHERE first_date IS NOT NULL AND last_date IS NOT NULL AND last_date >= ?1 AND first_date <= ?2".into(),
            vec![from.clone(), to.clone()],
        ),
        (Some(from), None) => (
            " WHERE last_date IS NOT NULL AND last_date >= ?1".into(),
            vec![from.clone()],
        ),
        (None, Some(to)) => (
            " WHERE first_date IS NOT NULL AND first_date <= ?1".into(),
            vec![to.clone()],
        ),
    }
}

pub fn parse_day(value: &str) -> Option<String> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .map(|day| day.format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::{decode_account_data, fixture, BATTLE_LEN, BATTLE_OUTCOME, BATTLE_STATUS, BEHAVIOR_LEN};
    use solana_pubkey::Pubkey;

    fn temp_db() -> (Connection, std::path::PathBuf) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("horizon-indexer-{}-{id}.db", std::process::id()));
        let conn = open(&path).expect("open");
        (conn, path)
    }

    fn cleanup(path: &Path) {
        let text = path.to_string_lossy().to_string();
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(format!("{text}-wal"));
        let _ = std::fs::remove_file(format!("{text}-shm"));
    }

    fn noon(day: &str) -> i64 {
        NaiveDate::parse_from_str(day, "%Y-%m-%d")
            .expect("day")
            .and_hms_opt(12, 0, 0)
            .expect("noon")
            .and_utc()
            .timestamp()
    }

    fn pubkey(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    #[test]
    fn date_range_filters_behaviors_battles_and_users() {
        let (conn, path) = temp_db();
        let creator = pubkey(7);
        let player_a = pubkey(3);
        let player_b = pubkey(4);
        let march = [1u8, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0];

        let mut early = fixture("Behavior", BEHAVIOR_LEN);
        early[8..40].copy_from_slice(creator.as_ref());
        early[40] = march.len() as u8;
        early[41..41 + march.len()].copy_from_slice(&march);
        let early_account = decode_account_data(&early).expect("early behavior");
        record(
            &conn,
            "behavior-early",
            &early_account,
            Some(noon("2026-10-01")),
        )
        .expect("insert early");

        let mut late = early.clone();
        late[8..40].copy_from_slice(pubkey(12).as_ref());
        let late_account = decode_account_data(&late).expect("late behavior");
        record(
            &conn,
            "behavior-late",
            &late_account,
            Some(noon("2026-10-06")),
        )
        .expect("insert late");

        let mut battle = fixture("Battle", BATTLE_LEN);
        battle[104..136].copy_from_slice(player_a.as_ref());
        battle[136..168].copy_from_slice(player_b.as_ref());
        battle[168..176].copy_from_slice(&50u64.to_le_bytes());
        battle[184] = 0;
        battle[185] = 0;
        battle[BATTLE_STATUS] = 0;
        let awaiting = decode_account_data(&battle).expect("awaiting");
        record(&conn, "battle-1", &awaiting, Some(noon("2026-10-01"))).expect("open");
        battle[BATTLE_STATUS] = 1;
        battle[BATTLE_OUTCOME] = 1;
        let resolved = decode_account_data(&battle).expect("resolved");
        record(&conn, "battle-1", &resolved, Some(noon("2026-10-06"))).expect("resolve");

        let week = DayRange {
            from: Some("2026-10-01".into()),
            to: Some("2026-10-06".into()),
        };
        let behavior_rows = behaviors(&conn, &week).expect("behaviors");
        assert_eq!(behavior_rows.len(), 2);
        assert_eq!(behavior_rows[0].summary, "1 element: March");
        assert_eq!(behavior_rows[0].element_count, 1);

        let sixth = DayRange {
            from: Some("2026-10-06".into()),
            to: Some("2026-10-06".into()),
        };
        let on_sixth = behaviors(&conn, &sixth).expect("sixth");
        assert_eq!(on_sixth.len(), 1);
        assert_eq!(on_sixth[0].pubkey, "behavior-late");

        let empty_day = DayRange {
            from: Some("2026-10-02".into()),
            to: Some("2026-10-02".into()),
        };
        assert!(behaviors(&conn, &empty_day).expect("empty").is_empty());
        assert!(behaviors(&conn, &DayRange::default()).expect("all").len() == 2);

        let battle_rows = battles(&conn, &sixth).expect("battles on resolve day");
        assert_eq!(battle_rows.len(), 1);
        assert_eq!(battle_rows[0].open_date.as_deref(), Some("2026-10-01"));
        assert_eq!(battle_rows[0].resolved_date.as_deref(), Some("2026-10-06"));
        assert_eq!(battle_rows[0].status, 1);
        assert_eq!(battle_rows[0].outcome, 1);
        assert_eq!(battle_rows[0].stake, "50");
        assert!(battles(&conn, &empty_day).expect("no battle").is_empty());
        assert_eq!(
            battles(
                &conn,
                &DayRange {
                    from: Some("2026-10-01".into()),
                    to: Some("2026-10-01".into())
                }
            )
            .expect("open day")
            .len(),
            1
        );

        let user_rows = users(
            &conn,
            &DayRange {
                from: Some("2026-10-01".into()),
                to: None,
            },
        )
        .expect("users");
        let wallets: Vec<_> = user_rows.iter().map(|user| user.wallet.as_str()).collect();
        assert!(wallets.contains(&creator.to_string().as_str()));
        assert!(wallets.contains(&player_a.to_string().as_str()));
        assert!(wallets.contains(&player_b.to_string().as_str()));
        let creator_row = user_rows
            .iter()
            .find(|user| user.wallet == creator.to_string())
            .expect("creator");
        assert_eq!(creator_row.behavior_count, 1);
        assert_eq!(creator_row.battle_count, 0);
        assert_eq!(creator_row.first_date.as_deref(), Some("2026-10-01"));
        let player = user_rows
            .iter()
            .find(|user| user.wallet == player_a.to_string())
            .expect("player");
        assert_eq!(player.battle_count, 1);
        assert_eq!(player.first_date.as_deref(), Some("2026-10-01"));
        assert_eq!(player.last_date.as_deref(), Some("2026-10-06"));
        assert!(users(
            &conn,
            &DayRange {
                from: Some("2026-10-03".into()),
                to: Some("2026-10-03".into())
            }
        )
        .expect("span")
        .iter()
        .any(|user| user.wallet == player_a.to_string()));
        assert!(users(
            &conn,
            &DayRange {
                from: Some("2026-10-07".into()),
                to: None
            }
        )
        .expect("after")
        .is_empty());

        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn forget_armies_drops_only_the_closed_keys() {
        let (conn, path) = temp_db();
        for key in ["kept", "closed"] {
            conn.execute(
                "INSERT INTO armies (pubkey, owner, battleground, race, idx, status, units_json)
                 VALUES (?1, 'owner', 'ground', 0, 0, 0, '[]')",
                [key],
            )
            .expect("insert");
        }
        let mut keys = army_keys(&conn).expect("keys");
        keys.sort();
        assert_eq!(keys, vec!["closed".to_string(), "kept".to_string()]);
        assert_eq!(forget_armies(&conn, &["closed".to_string(), "never".to_string()]).expect("forget"), 1);
        assert_eq!(army_keys(&conn).expect("keys"), vec!["kept".to_string()]);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn empty_database_queries_are_empty() {
        let (conn, path) = temp_db();
        let day = DayRange {
            from: Some("2026-10-06".into()),
            to: Some("2026-10-06".into()),
        };
        assert!(behaviors(&conn, &day).expect("behaviors").is_empty());
        assert!(battles(&conn, &day).expect("battles").is_empty());
        assert!(users(&conn, &day).expect("users").is_empty());
        let empty = stats(&conn, 1_000_000).expect("stats");
        assert_eq!(empty.battles_fought, 0);
        assert_eq!(empty.staked_lamports, "0");
        assert!(empty.battlegrounds.is_empty());
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn stats_count_battles_stakes_queues_and_players() {
        let (conn, path) = temp_db();
        let now = noon("2026-10-13");
        conn.execute_batch(
            "INSERT INTO battlegrounds VALUES ('g0', 0, 8, '50000000', 8, 6, 2, '[\"q1\",\"q2\"]', 3);
             INSERT INTO battlegrounds VALUES ('g1', 1, 16, '200000000', 10, 8, 2, '[]', 1);
             INSERT INTO users (wallet) VALUES ('w1'), ('w2'), ('w3');
             INSERT INTO behaviors (pubkey, creator, body_json, element_count, summary) VALUES ('b1', 'w1', '[]', 1, '');",
        )
        .expect("seed");
        let battle = |key: &str, ground: &str, stake: &str, status: i64, outcome: i64, resolved: Option<i64>| {
            conn.execute(
                "INSERT INTO matches (pubkey, battleground, army_a, army_b, player_a, player_b, stake, seq, cols, rows,
                     units_a, units_b, status, seed, outcome, resolved_at)
                 VALUES (?1, ?2, 'a', 'b', 'w1', 'w2', ?3, 0, 8, 6, '[]', '[]', ?4, '', ?5, ?6)",
                rusqlite::params![key, ground, stake, status, outcome, resolved],
            )
            .expect("battle");
        };
        battle("m1", "g0", "50000000", 1, 1, Some(now - 3_600));
        battle("m2", "g0", "50000000", 1, 3, Some(now - 3 * 86_400));
        battle("m3", "g1", "200000000", 1, 2, Some(now - 60));
        battle("m4", "g1", "200000000", 2, 0, None);
        let got = stats(&conn, now).expect("stats");
        assert_eq!(
            got,
            StatsOut {
                battles_fought: 3,
                battles_today: 2,
                battles_awaiting: 1,
                draws: 1,
                players: 3,
                behaviors: 1,
                armies_locked: 2,
                staked_lamports: (2 * (50_000_000u64 * 2 + 200_000_000 * 2)).to_string(),
                battlegrounds: vec![
                    GroundStatsOut { battleground_id: 0, locked: 2, battles_fought: 2 },
                    GroundStatsOut { battleground_id: 1, locked: 0, battles_fought: 1 },
                ],
                generated_at: now,
            }
        );
        drop(conn);
        cleanup(&path);
    }
}
