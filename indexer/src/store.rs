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

/// `matches.status`: the program's Awaiting 0, Resolved 1 and Seeded 2, plus the indexer's own
/// Cancelled 3 for a battle `cancel_match` closed (the program has no such status: it closes the
/// account).
pub const STATUS_AWAITING: u8 = 0;
pub const STATUS_CANCELLED: u8 = 3;
const ZERO_SEED: &str = "0000000000000000000000000000000000000000000000000000000000000000";

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
    resolved_date TEXT,
    fee TEXT,
    fee_bps INTEGER
);
CREATE INDEX IF NOT EXISTS matches_open_date ON matches(open_date);
CREATE INDEX IF NOT EXISTS matches_resolved_date ON matches(resolved_date);

CREATE TABLE IF NOT EXISTS resolutions (
    pubkey TEXT PRIMARY KEY,
    outcome INTEGER NOT NULL,
    fee TEXT NOT NULL,
    resolved_at INTEGER,
    seed TEXT
);

CREATE TABLE IF NOT EXISTS cancellations (
    pubkey TEXT PRIMARY KEY,
    cancelled_at INTEGER
);

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
    /// Lamports the protocol took, a decimal string. Null until the battle settles; a draw is `"0"`.
    pub fee: Option<String>,
    /// Config's fee rate when the battle opened. Null on a row stored before the column existed.
    pub fee_bps: Option<u16>,
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
    let matches = table_columns(conn, "matches")?;
    for (column, kind) in [("fee", "TEXT"), ("fee_bps", "INTEGER")] {
        if !matches.is_empty() && !matches.iter().any(|name| name == column) {
            conn.execute_batch(&format!("ALTER TABLE matches ADD COLUMN {column} {kind};"))?;
        }
    }
    // A resolution stored before seeds were has none, never matches a row, and is dropped when its
    // battle's Seeded update arrives.
    let resolutions = table_columns(conn, "resolutions")?;
    if !resolutions.is_empty() && !resolutions.iter().any(|name| name == "seed") {
        conn.execute_batch("ALTER TABLE resolutions ADD COLUMN seed TEXT;")?;
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

/// A battle's seed is all zeros while it is Awaiting and is set once, by `seed_match`. An update that
/// would take a seeded row back to zeros is a stale snapshot and is skipped. A different non-zero
/// seed is a new battle at a reused address (seq restarts after a ledger reset): its row starts over.
/// The stored resolution with the same seed, if any, settles the row.
///
/// `open_at` is the battle's own `opened_at` (the program's Clock) when it has one, else the block
/// time of the first Awaiting observation. A Cancelled row is never seeded again: an Awaiting
/// snapshot with the same open time is stale and skipped, and one with another open time is a new
/// battle at the address. A cancellation stored before its row (see `cancel`) applies to an
/// Awaiting battle that opened no later than the cancel.
fn record_battle(
    conn: &Connection,
    pubkey: &str,
    battle: &BattleAccount,
    unix: Option<i64>,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let existing = tx
        .query_row(
            "SELECT open_at, seed, status FROM matches WHERE pubkey = ?1",
            [pubkey],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, String>(1)?, row.get::<_, u8>(2)?)),
        )
        .optional()?;
    let seeded = !is_zero_seed(&battle.seed);
    let chain_open = (battle.opened_at > 0).then_some(battle.opened_at);
    let mut open_at = None;
    if let Some((stored_open, stored_seed, stored_status)) = existing {
        if !is_zero_seed(&stored_seed) && !seeded {
            return Ok(());
        }
        if stored_status == STATUS_CANCELLED && !seeded && (chain_open.is_none() || chain_open == stored_open) {
            return Ok(());
        }
        if is_zero_seed(&stored_seed) || stored_seed == battle.seed {
            open_at = stored_open;
        }
    }
    if chain_open.is_some() {
        open_at = chain_open;
    } else if battle.status == STATUS_AWAITING && open_at.is_none() {
        // The first observation while Awaiting supplies the open time. A later write does not replace it.
        open_at = unix;
    }
    // Some(time) when a stored cancellation applies; the time is None when the log had no block time.
    let mut cancelled_at: Option<Option<i64>> = None;
    let pending: Option<Option<i64>> = tx
        .query_row("SELECT cancelled_at FROM cancellations WHERE pubkey = ?1", [pubkey], |row| row.get(0))
        .optional()?;
    if let Some(at) = pending {
        let awaiting = !seeded && battle.status == STATUS_AWAITING;
        match (at, open_at) {
            (Some(at), Some(open)) if awaiting && open <= at => cancelled_at = Some(Some(at)),
            (Some(_), None) if awaiting => cancelled_at = Some(at),
            // A cancel with no time cannot be ordered against the battle: it applies to the first
            // Awaiting row and is then used up, so it cannot cancel a later battle at the address.
            (None, _) if awaiting => {
                cancelled_at = Some(None);
                tx.execute("DELETE FROM cancellations WHERE pubkey = ?1", [pubkey])?;
            }
            // A seeded battle (never cancellable), or one opened after the cancel: an older battle's.
            (_, open) if seeded || matches!((at, open), (Some(at), Some(open)) if open > at) => {
                tx.execute("DELETE FROM cancellations WHERE pubkey = ?1", [pubkey])?;
            }
            _ => {}
        }
    }
    let mut resolution = None;
    if seeded {
        let stored = tx
            .query_row("SELECT outcome, fee, resolved_at, seed FROM resolutions WHERE pubkey = ?1", [pubkey], |row| {
                Ok((row.get::<_, u8>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, Option<String>>(3)?))
            })
            .optional()?;
        if let Some((outcome, fee, resolved_at, seed)) = stored {
            if seed.as_deref() == Some(battle.seed.as_str()) {
                resolution = Some((outcome, fee, resolved_at));
            } else {
                // Another battle's resolution, or one stored before seeds were: it can never apply here.
                tx.execute("DELETE FROM resolutions WHERE pubkey = ?1", [pubkey])?;
            }
        }
    }
    let (status, outcome, fee, resolved_at) = match (resolution, cancelled_at) {
        (Some((outcome, fee, resolved_at)), _) => (1, outcome, Some(fee), resolved_at),
        (None, Some(at)) => (STATUS_CANCELLED, 0, None, at),
        (None, None) => (battle.status, battle.outcome, None, None),
    };
    let units_a: Vec<BattleUnitOut> = battle.units_a.iter().map(|unit| battle_unit_out(unit, battle.race_a)).collect();
    let units_b: Vec<BattleUnitOut> = battle.units_b.iter().map(|unit| battle_unit_out(unit, battle.race_b)).collect();
    tx.execute(
        "INSERT INTO matches (
            pubkey, battleground, army_a, army_b, player_a, player_b, stake, seq,
            cols, rows, units_a, units_b, status, seed, outcome,
            open_at, resolved_at, open_date, resolved_date, fee, fee_bps
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
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
            resolved_date = excluded.resolved_date,
            fee = excluded.fee,
            fee_bps = excluded.fee_bps",
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
            status,
            battle.seed,
            outcome,
            open_at,
            resolved_at,
            open_at.and_then(utc_day),
            resolved_at.and_then(utc_day),
            fee,
            battle.fee_bps,
        ],
    )?;
    tx.commit()
}

fn is_zero_seed(seed: &str) -> bool {
    seed.bytes().all(|byte| byte == b'0')
}

/// Records `HZ_MATCH_RESOLVED`. `settle_match` closes the battle, so the log is the only place the
/// outcome and fee appear. The resolution is kept on its own, keyed by battle and tagged with the
/// seed: it settles the row only while the row holds that seed. So a log that arrives before the
/// battle's Seeded row, or a stale account update after the log, still ends on Resolved, and an old
/// battle's resolution never settles a new battle at the same address.
pub fn resolve(
    conn: &Connection,
    pubkey: &str,
    outcome: u8,
    fee: u64,
    seed: &str,
    unix: Option<i64>,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO resolutions (pubkey, outcome, fee, resolved_at, seed) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(pubkey) DO UPDATE SET
            outcome = excluded.outcome,
            fee = excluded.fee,
            resolved_at = CASE WHEN resolutions.seed IS excluded.seed
                THEN COALESCE(resolutions.resolved_at, excluded.resolved_at)
                ELSE excluded.resolved_at END,
            seed = excluded.seed",
        params![pubkey, outcome, fee.to_string(), unix, seed],
    )?;
    let resolved_at: Option<i64> =
        tx.query_row("SELECT resolved_at FROM resolutions WHERE pubkey = ?1", [pubkey], |row| row.get(0))?;
    tx.execute(
        "UPDATE matches SET
            status = 1,
            outcome = ?2,
            fee = ?3,
            resolved_at = ?4,
            resolved_date = ?5
         WHERE pubkey = ?1 AND seed = ?6",
        params![pubkey, outcome, fee.to_string(), resolved_at, resolved_at.and_then(utc_day), seed],
    )?;
    tx.commit()
}

/// Records `HZ_MATCH_CANCELLED`. `cancel_match` closes the battle, so the log is the only sign of it.
/// The row becomes Cancelled (3) only while it is still Awaiting with a zero seed and opened no later
/// than the cancel (`unix`, the log's block time; unknown times do not block it). A seeded battle
/// cannot be cancelled, and a battle opened after the cancel is a newer one at a reused address, so
/// neither is touched. The cancellation is also kept, so a log that arrives before its battle's row
/// applies when the row does (see `record_battle`). One with no block time applies to the first
/// Awaiting row only and is then dropped. `resolved_at` holds the cancel time, null when unknown.
pub fn cancel(conn: &Connection, pubkey: &str, unix: Option<i64>) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO cancellations (pubkey, cancelled_at) VALUES (?1, ?2)
         ON CONFLICT(pubkey) DO UPDATE SET cancelled_at = excluded.cancelled_at",
        params![pubkey, unix],
    )?;
    let applied = tx.execute(
        "UPDATE matches SET status = ?2, resolved_at = ?3, resolved_date = ?4
         WHERE pubkey = ?1 AND status = ?5 AND seed = ?6
           AND (?3 IS NULL OR open_at IS NULL OR open_at <= ?3)",
        params![pubkey, STATUS_CANCELLED, unix, unix.and_then(utc_day), STATUS_AWAITING, ZERO_SEED],
    )?;
    if applied > 0 && unix.is_none() {
        // Used up: a timeless cancel must not wait for a later battle at the address.
        tx.execute("DELETE FROM cancellations WHERE pubkey = ?1", [pubkey])?;
    }
    tx.commit()
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
        // Awaiting or Seeded: neither settled nor cancelled.
        battles_awaiting: count("SELECT COUNT(*) FROM matches WHERE status IN (0, 2)", &[])?,
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
                open_at, resolved_at, open_date, resolved_date, fee, fee_bps
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
                open_at, resolved_at, open_date, resolved_date, fee, fee_bps
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
        fee: row.get(19)?,
        fee_bps: row.get(20)?,
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
        battle[BATTLE_STATUS] = 2;
        battle[BATTLE_STATUS + 1..BATTLE_OUTCOME].fill(1);
        let seeded = decode_account_data(&battle).expect("seeded");
        record(&conn, "battle-1", &seeded, Some(noon("2026-10-06"))).expect("seed");
        resolve(&conn, "battle-1", 1, 0, &"01".repeat(32), Some(noon("2026-10-06"))).expect("resolve");

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

    /// A battle account with status Awaiting (seed byte 0) or Seeded with that seed byte.
    fn battle_account(fee_bps: u16, seed: u8) -> HorizonAccount {
        let mut battle = fixture("Battle", BATTLE_LEN);
        battle[104..136].copy_from_slice(pubkey(3).as_ref());
        battle[136..168].copy_from_slice(pubkey(4).as_ref());
        battle[168..176].copy_from_slice(&50u64.to_le_bytes());
        battle[BATTLE_STATUS] = if seed == 0 { 0 } else { 2 };
        battle[BATTLE_STATUS + 1..BATTLE_OUTCOME].fill(seed);
        battle[BATTLE_OUTCOME + 3..BATTLE_OUTCOME + 5].copy_from_slice(&fee_bps.to_le_bytes());
        decode_account_data(&battle).expect("battle")
    }

    fn seeded_battle(fee_bps: u16) -> HorizonAccount {
        battle_account(fee_bps, 9)
    }

    fn seed(byte: u8) -> String {
        format!("{byte:02x}").repeat(32)
    }

    #[test]
    fn resolved_log_settles_the_seeded_row_and_a_stale_update_does_not_undo_it() {
        let (conn, path) = temp_db();
        record(&conn, "battle-1", &seeded_battle(500), Some(noon("2026-10-05"))).expect("seeded");
        let row = battle(&conn, "battle-1").expect("read").expect("row");
        assert_eq!((row.status, row.outcome, row.fee.as_deref(), row.fee_bps), (2, 0, None, Some(500)));

        resolve(&conn, "battle-1", 1, 1_000_000, &seed(9), Some(noon("2026-10-06"))).expect("resolve");
        let row = battle(&conn, "battle-1").expect("read").expect("row");
        assert_eq!((row.status, row.outcome, row.fee.as_deref()), (1, 1, Some("1000000")));
        assert_eq!(row.resolved_at, Some(noon("2026-10-06")));
        assert_eq!(row.resolved_date.as_deref(), Some("2026-10-06"));

        // A snapshot read before the settlement can still land after the log, Seeded or even Awaiting.
        record(&conn, "battle-1", &seeded_battle(500), Some(noon("2026-10-05"))).expect("stale");
        record(&conn, "battle-1", &battle_account(500, 0), Some(noon("2026-10-04"))).expect("stale awaiting");
        let row = battle(&conn, "battle-1").expect("read").expect("row");
        assert_eq!((row.status, row.outcome, row.fee.as_deref()), (1, 1, Some("1000000")));
        assert_eq!(row.resolved_date.as_deref(), Some("2026-10-06"));
        assert_eq!(row.seed, seed(9));

        let json = serde_json::to_value(&battles(&conn, &DayRange::default()).expect("all")[0]).expect("json");
        assert_eq!(json["fee"], "1000000");
        assert_eq!(json["feeBps"], 500);
        assert_eq!(json["status"], 1);
        assert_eq!(stats(&conn, noon("2026-10-06")).expect("stats").battles_fought, 1);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn a_resolution_seen_before_its_battle_is_applied_when_the_battle_arrives() {
        let (conn, path) = temp_db();
        resolve(&conn, "battle-2", 3, 0, &seed(9), Some(noon("2026-10-06"))).expect("resolve");
        assert!(battle(&conn, "battle-2").expect("read").is_none());
        assert!(battles(&conn, &DayRange::default()).expect("all").is_empty());

        record(&conn, "battle-2", &seeded_battle(250), Some(noon("2026-10-05"))).expect("seeded");
        let row = battle(&conn, "battle-2").expect("read").expect("row");
        assert_eq!((row.status, row.outcome, row.fee.as_deref(), row.fee_bps), (1, 3, Some("0"), Some(250)));
        assert_eq!(row.resolved_at, Some(noon("2026-10-06")));
        // A repeated log keeps the first resolution time.
        resolve(&conn, "battle-2", 3, 0, &seed(9), Some(noon("2026-10-07"))).expect("again");
        assert_eq!(battle(&conn, "battle-2").expect("read").expect("row").resolved_at, Some(noon("2026-10-06")));
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn an_awaiting_row_waits_for_its_seeded_snapshot_before_the_resolution_applies() {
        let (conn, path) = temp_db();
        record(&conn, "battle-3", &battle_account(100, 0), Some(noon("2026-10-04"))).expect("awaiting");
        resolve(&conn, "battle-3", 2, 5, &seed(7), Some(noon("2026-10-06"))).expect("resolve");
        let row = battle(&conn, "battle-3").expect("read").expect("row");
        assert_eq!((row.status, row.outcome, row.fee.as_deref(), row.resolved_at), (0, 0, None, None));

        record(&conn, "battle-3", &battle_account(100, 7), Some(noon("2026-10-05"))).expect("seeded");
        let row = battle(&conn, "battle-3").expect("read").expect("row");
        assert_eq!((row.status, row.outcome, row.fee.as_deref()), (1, 2, Some("5")));
        assert_eq!(row.open_date.as_deref(), Some("2026-10-04"));
        assert_eq!(row.resolved_date.as_deref(), Some("2026-10-06"));
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn a_reused_battle_address_is_not_resolved_by_the_old_battle() {
        let (conn, path) = temp_db();
        // The old battle: seeded with 9, settled.
        record(&conn, "battle-4", &battle_account(100, 0), Some(noon("2026-10-01"))).expect("old awaiting");
        record(&conn, "battle-4", &battle_account(100, 9), Some(noon("2026-10-01"))).expect("old seeded");
        resolve(&conn, "battle-4", 1, 5, &seed(9), Some(noon("2026-10-02"))).expect("old resolve");
        assert_eq!(battle(&conn, "battle-4").expect("read").expect("row").status, 1);

        // A ledger reset reuses the address. The new battle shows up once it is seeded with another seed.
        record(&conn, "battle-4", &battle_account(300, 4), Some(noon("2026-10-06"))).expect("new seeded");
        let row = battle(&conn, "battle-4").expect("read").expect("row");
        assert_eq!((row.status, row.outcome, row.fee.as_deref(), row.fee_bps), (2, 0, None, Some(300)));
        assert_eq!((row.open_at, row.resolved_at, row.resolved_date.as_deref()), (None, None, None));
        assert_eq!(row.seed, seed(4));
        // The old resolution is gone: the old battle's log cannot settle the new one.
        resolve(&conn, "battle-4", 1, 5, &seed(9), Some(noon("2026-10-07"))).expect("replayed old log");
        assert_eq!(battle(&conn, "battle-4").expect("read").expect("row").status, 2);

        // The new battle's own log settles it.
        resolve(&conn, "battle-4", 2, 8, &seed(4), Some(noon("2026-10-08"))).expect("new resolve");
        let row = battle(&conn, "battle-4").expect("read").expect("row");
        assert_eq!((row.status, row.outcome, row.fee.as_deref()), (1, 2, Some("8")));
        assert_eq!(row.resolved_date.as_deref(), Some("2026-10-08"));

        // The new battle's log can also come first, while the row still holds the old battle.
        record(&conn, "battle-5", &battle_account(100, 9), None).expect("old seeded");
        resolve(&conn, "battle-5", 1, 5, &seed(9), Some(noon("2026-10-02"))).expect("old resolve");
        resolve(&conn, "battle-5", 3, 0, &seed(4), Some(noon("2026-10-08"))).expect("new log first");
        let row = battle(&conn, "battle-5").expect("read").expect("row");
        assert_eq!((row.status, row.outcome, row.fee.as_deref()), (1, 1, Some("5")));
        record(&conn, "battle-5", &battle_account(100, 4), None).expect("new seeded");
        let row = battle(&conn, "battle-5").expect("read").expect("row");
        assert_eq!((row.status, row.outcome, row.fee.as_deref()), (1, 3, Some("0")));
        assert_eq!(row.resolved_date.as_deref(), Some("2026-10-08"));
        drop(conn);
        cleanup(&path);
    }

    /// An Awaiting battle that `lock_army` opened at `opened_at`, or Seeded with `seed` when non-zero.
    fn battle_opened(opened_at: i64, seed: u8) -> HorizonAccount {
        let mut battle = fixture("Battle", BATTLE_LEN);
        battle[104..136].copy_from_slice(pubkey(3).as_ref());
        battle[136..168].copy_from_slice(pubkey(4).as_ref());
        battle[168..176].copy_from_slice(&50u64.to_le_bytes());
        battle[BATTLE_STATUS] = if seed == 0 { 0 } else { 2 };
        battle[BATTLE_STATUS + 1..BATTLE_OUTCOME].fill(seed);
        battle[BATTLE_OUTCOME + 5..BATTLE_OUTCOME + 13].copy_from_slice(&opened_at.to_le_bytes());
        decode_account_data(&battle).expect("battle")
    }

    #[test]
    fn a_cancel_log_ends_an_awaiting_row_and_a_stale_snapshot_does_not_undo_it() {
        let (conn, path) = temp_db();
        let opened = noon("2026-10-05");
        record(&conn, "battle-c1", &battle_opened(opened, 0), Some(opened + 3)).expect("awaiting");
        let row = battle(&conn, "battle-c1").expect("read").expect("row");
        assert_eq!((row.status, row.open_at), (0, Some(opened)), "open_at is the battle's own opened_at");
        assert_eq!(stats(&conn, opened).expect("stats").battles_awaiting, 1);

        cancel(&conn, "battle-c1", Some(opened + 700)).expect("cancel");
        let row = battle(&conn, "battle-c1").expect("read").expect("row");
        assert_eq!((row.status, row.outcome, row.fee.as_deref(), row.resolved_at), (3, 0, None, Some(opened + 700)));
        let json = serde_json::to_value(&row).expect("json");
        assert_eq!(json["status"], 3);
        let counts = stats(&conn, opened + 700).expect("stats");
        assert_eq!((counts.battles_awaiting, counts.battles_fought), (0, 0));

        // An Awaiting snapshot read before the cancel lands after it; a repeated log changes nothing.
        record(&conn, "battle-c1", &battle_opened(opened, 0), Some(opened + 5)).expect("stale");
        cancel(&conn, "battle-c1", Some(opened + 900)).expect("again");
        let row = battle(&conn, "battle-c1").expect("read").expect("row");
        assert_eq!((row.status, row.resolved_at), (3, Some(opened + 700)));
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn a_cancel_never_touches_a_seeded_row_or_a_newer_battle_at_the_address() {
        let (conn, path) = temp_db();
        let opened = noon("2026-10-05");
        // A seeded battle cannot be cancelled: such a log is not this battle's.
        record(&conn, "battle-c2", &battle_opened(opened, 7), None).expect("seeded");
        cancel(&conn, "battle-c2", Some(opened + 700)).expect("cancel");
        assert_eq!(battle(&conn, "battle-c2").expect("read").expect("row").status, 2);

        // An old battle cancelled; a ledger reset reuses the address for a battle opened later.
        record(&conn, "battle-c3", &battle_opened(opened, 0), None).expect("old awaiting");
        cancel(&conn, "battle-c3", Some(opened + 700)).expect("old cancel");
        let later = opened + 86_400;
        record(&conn, "battle-c3", &battle_opened(later, 0), Some(later)).expect("new awaiting");
        let row = battle(&conn, "battle-c3").expect("read").expect("row");
        assert_eq!((row.status, row.open_at, row.resolved_at), (0, Some(later), None));
        // The old log replayed does not cancel the new battle; nor does a later snapshot of it.
        cancel(&conn, "battle-c3", Some(opened + 700)).expect("replayed old log");
        record(&conn, "battle-c3", &battle_opened(later, 0), Some(later)).expect("new awaiting again");
        assert_eq!(battle(&conn, "battle-c3").expect("read").expect("row").status, 0);
        // The new battle seeds and resolves as usual.
        record(&conn, "battle-c3", &battle_opened(later, 4), None).expect("new seeded");
        resolve(&conn, "battle-c3", 2, 8, &seed(4), Some(later + 60)).expect("resolve");
        assert_eq!(battle(&conn, "battle-c3").expect("read").expect("row").status, 1);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn a_cancel_seen_before_its_battle_applies_only_to_a_battle_opened_before_it() {
        let (conn, path) = temp_db();
        let opened = noon("2026-10-05");
        cancel(&conn, "battle-c4", Some(opened + 650)).expect("cancel first");
        assert!(battle(&conn, "battle-c4").expect("read").is_none());
        record(&conn, "battle-c4", &battle_opened(opened, 0), None).expect("awaiting");
        let row = battle(&conn, "battle-c4").expect("read").expect("row");
        assert_eq!((row.status, row.resolved_at), (3, Some(opened + 650)));

        // A stored cancel older than the battle is another battle's: it is dropped.
        cancel(&conn, "battle-c5", Some(opened - 10)).expect("old cancel");
        record(&conn, "battle-c5", &battle_opened(opened, 0), None).expect("newer awaiting");
        assert_eq!(battle(&conn, "battle-c5").expect("read").expect("row").status, 0);
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM cancellations WHERE pubkey = 'battle-c5'", [], |row| row.get(0))
            .expect("count");
        assert_eq!(left, 0);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn a_cancel_without_a_block_time_applies_once_to_an_awaiting_row() {
        let (conn, path) = temp_db();
        let opened = noon("2026-10-05");
        // The row exists: the cancel applies at once and is used up.
        record(&conn, "battle-c6", &battle_opened(opened, 0), None).expect("awaiting");
        cancel(&conn, "battle-c6", None).expect("cancel");
        let row = battle(&conn, "battle-c6").expect("read").expect("row");
        assert_eq!((row.status, row.resolved_at), (3, None));

        // The log comes first: the first Awaiting row is cancelled, a later battle at the address is not.
        cancel(&conn, "battle-c7", None).expect("cancel first");
        record(&conn, "battle-c7", &battle_opened(opened, 0), None).expect("awaiting");
        assert_eq!(battle(&conn, "battle-c7").expect("read").expect("row").status, 3);
        record(&conn, "battle-c7", &battle_opened(opened, 0), None).expect("stale awaiting");
        assert_eq!(battle(&conn, "battle-c7").expect("read").expect("row").status, 3);
        record(&conn, "battle-c7", &battle_opened(opened + 86_400, 0), None).expect("new battle");
        assert_eq!(battle(&conn, "battle-c7").expect("read").expect("row").status, 0);
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM cancellations", [], |row| row.get(0)).expect("count");
        assert_eq!(left, 0);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn a_resolution_stored_without_a_seed_is_stale() {
        let (conn, path) = temp_db();
        conn.execute("INSERT INTO resolutions (pubkey, outcome, fee, resolved_at) VALUES ('battle-6', 1, '5', 1)", [])
            .expect("old resolution");
        record(&conn, "battle-6", &seeded_battle(0), None).expect("seeded");
        let row = battle(&conn, "battle-6").expect("read").expect("row");
        assert_eq!((row.status, row.fee), (2, None));
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM resolutions", [], |row| row.get(0)).expect("count");
        assert_eq!(left, 0);
        drop(conn);
        cleanup(&path);
    }

    #[test]
    fn older_tables_gain_the_fee_and_seed_columns() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir()
            .join(format!("horizon-indexer-old-{}-{}.db", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        {
            let old = Connection::open(&path).expect("old");
            old.execute_batch(
                "CREATE TABLE behaviors (pubkey TEXT PRIMARY KEY, creator TEXT NOT NULL, body_json TEXT NOT NULL,
                     element_count INTEGER NOT NULL, summary TEXT NOT NULL, created_at INTEGER, updated_at INTEGER,
                     created_date TEXT, updated_date TEXT);
                 CREATE TABLE matches (pubkey TEXT PRIMARY KEY, battleground TEXT NOT NULL, army_a TEXT NOT NULL,
                     army_b TEXT NOT NULL, player_a TEXT NOT NULL, player_b TEXT NOT NULL, stake TEXT NOT NULL,
                     seq INTEGER NOT NULL, cols INTEGER NOT NULL, rows INTEGER NOT NULL, units_a TEXT NOT NULL,
                     units_b TEXT NOT NULL, status INTEGER NOT NULL, seed TEXT NOT NULL, outcome INTEGER NOT NULL,
                     open_at INTEGER, resolved_at INTEGER, open_date TEXT, resolved_date TEXT);
                 CREATE TABLE resolutions (pubkey TEXT PRIMARY KEY, outcome INTEGER NOT NULL, fee TEXT NOT NULL,
                     resolved_at INTEGER);
                 INSERT INTO matches (pubkey, battleground, army_a, army_b, player_a, player_b, stake, seq, cols, rows,
                     units_a, units_b, status, seed, outcome)
                 VALUES ('kept', 'g', 'a', 'b', 'w1', 'w2', '5', 0, 8, 6, '[]', '[]', 1, '', 2);",
            )
            .expect("old schema");
        }
        let conn = open(&path).expect("migrate");
        let columns = table_columns(&conn, "matches").expect("columns");
        assert!(columns.iter().any(|name| name == "fee"));
        assert!(columns.iter().any(|name| name == "fee_bps"));
        assert!(table_columns(&conn, "resolutions").expect("columns").iter().any(|name| name == "seed"));
        let row = battle(&conn, "kept").expect("read").expect("kept row");
        assert_eq!((row.outcome, row.fee, row.fee_bps), (2, None, None));
        drop(conn);
        // Opening again finds the columns and leaves them be.
        drop(open(&path).expect("reopen"));
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
        // Pruning is for armies only: a settled battle's account is closed too, and its row stays.
        record(&conn, "closed", &seeded_battle(0), None).expect("battle");
        resolve(&conn, "closed", 1, 7, &seed(9), None).expect("resolve");
        forget_armies(&conn, &["closed".to_string()]).expect("forget again");
        assert!(battle(&conn, "closed").expect("read").is_some());
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
