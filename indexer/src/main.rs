//! Horizon Zero indexer.
//!
//! Carbon's RPC block subscription emits transactions and block details, not
//! account updates, so this process does not use it and does not use Geyser.
//! `SOLANA_RPC_URL` is the MagicBlock ephemeral rollup's RPC: Armies, Behaviors
//! and Battles exist only there, and Battlegrounds and Players are delegated to it.
//! The pipeline's account decoder is fed by two RPC sources in this crate:
//! `getProgramAccounts` on `SOLANA_RPC_URL`, then WebSocket `programSubscribe`,
//! which takes a fresh `getProgramAccounts` snapshot after every (re)subscribe.
//! Rows keep the slot they were written from, and an update from an earlier
//! slot does not overwrite them.
//! A third source, WebSocket `logsSubscribe`, reads `HZ_MATCH_RESOLVED`:
//! `settle_match` closes the battle, so the outcome and fee are only in that log.
//! A websocket URL is derived from the HTTP URL the same way the previous
//! client did: `http` becomes `ws`, `https` becomes `wss`, and an explicit
//! port is incremented by one so the local rollup `127.0.0.1:7799` is dialed
//! on 7800. A refused dial is logged and tried again every 3 seconds until
//! this process shuts down. The pipeline stays up.
//!
//! Account updates carry a slot. Block time is `getBlockTime` for that slot,
//! asked up to five times 200 ms apart: the rollup has no time for a slot until
//! about 100 ms after it. If the RPC still has none, the row is stored with a
//! null timestamp. An account update in a slot within `NEAR_SLOTS` of a slot
//! already timed takes that slot's time instead of asking.
//!
//! `close_army` hands the account back to the System Program, and
//! `programSubscribe` only reports accounts the program still owns, so a
//! closed army never arrives as an update. Every `PRUNE_EVERY` the indexer
//! reads its stored armies with `getMultipleAccounts` and deletes the rows
//! whose account is gone or no longer owned by the program, unless the row was
//! written from a slot later than the one that answer was read at.

mod decode;
mod http;
mod sources;
mod store;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use carbon_core::account::AccountProcessorInputType;
use carbon_core::error::CarbonResult;
use carbon_core::processor::Processor;
use carbon_log_metrics::LogMetrics;
use decode::{HorizonAccount, HorizonDecoder, PROGRAM_ID};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use sources::{LogsSubscribe, ProgramLogs, ProgramSnapshot, ProgramSubscribe, SnapshotHook};
use tokio_util::sync::CancellationToken;

const PRUNE_EVERY: Duration = Duration::from_secs(30);

struct Config {
    rpc_url: String,
    program_id: Pubkey,
    database_path: PathBuf,
    port: u16,
}

fn main() {
    let repo = find_repo_root();
    let file = load_env_file(&repo.join(".env"));
    let config = match Config::load(&repo, &file) {
        Ok(config) => config,
        Err(err) => {
            eprintln!("indexer: {err}");
            std::process::exit(1);
        }
    };
    let filter = std::env::var("RUST_LOG")
        .ok()
        .or_else(|| file.get("RUST_LOG").cloned())
        .unwrap_or_else(|| "info".to_string());
    env_logger::Builder::new().parse_filters(&filter).init();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    if let Err(err) = runtime.block_on(run(config)) {
        log::error!("{err}");
        std::process::exit(1);
    }
}

async fn run(config: Config) -> Result<(), String> {
    let connection = store::open(&config.database_path).map_err(|err| err.to_string())?;
    let db = Arc::new(Mutex::new(connection));
    let app = http::router(http::AppState {
        db: Arc::clone(&db),
    });
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port))
        .await
        .map_err(|err| format!("bind {}: {err}", config.port))?;
    let ws_url = rpc_to_ws(&config.rpc_url);
    log::info!(
        "indexer :{} db {} rollup rpc {} ws {} program {}",
        config.port,
        config.database_path.display(),
        config.rpc_url,
        ws_url,
        config.program_id
    );

    let processor = IndexProcessor {
        db: Arc::clone(&db),
        rpc: RpcClient::new_with_timeout_and_commitment(
            config.rpc_url.clone(),
            Duration::from_secs(10),
            CommitmentConfig::confirmed(),
        ),
        times: BTreeMap::new(),
    };
    let snapshot_db = Arc::clone(&db);
    let on_snapshot: SnapshotHook = Arc::new(move |slot| match snapshot_db.lock() {
        Ok(conn) => match store::rewind_slots(&conn, slot) {
            Ok(true) => log::warn!("stored slots are past the RPC's slot {slot}: the ledger was reset; slots cleared"),
            Ok(false) => {}
            Err(err) => log::error!("snapshot slot check: {err}"),
        },
        Err(_) => log::error!("snapshot slot check: sqlite lock poisoned"),
    });
    let mut pipeline = carbon_core::pipeline::Pipeline::builder()
        .datasource(ProgramSnapshot::new(
            config.rpc_url.clone(),
            config.program_id,
            Arc::clone(&on_snapshot),
        ))
        .datasource(ProgramSubscribe::new(ws_url.clone(), config.rpc_url.clone(), config.program_id, on_snapshot))
        .metrics(Arc::new(LogMetrics::new()))
        .account(HorizonDecoder, processor)
        .shutdown_strategy(carbon_core::pipeline::ShutdownStrategy::Immediate)
        .build()
        .map_err(|err| format!("pipeline: {err:?}"))?;

    tokio::spawn(prune_closed_armies(
        Arc::clone(&db),
        config.rpc_url.clone(),
        config.program_id,
    ));

    let (logs_tx, logs_rx) = tokio::sync::mpsc::channel(256);
    let logs_stop = CancellationToken::new();
    let logs_source = LogsSubscribe::new(ws_url, config.program_id);
    let logs_cancel = logs_stop.clone();
    tokio::spawn(async move {
        logs_source.consume(logs_tx, logs_cancel.clone()).await;
        if !logs_cancel.is_cancelled() {
            log::error!("logs subscribe stopped before shutdown; battles settled from now on stay Seeded");
        }
    });
    tokio::spawn(record_resolutions(
        Arc::clone(&db),
        config.rpc_url.clone(),
        config.program_id,
        logs_rx,
        logs_stop.clone(),
    ));

    tokio::spawn(async move {
        if let Err(err) = pipeline.run().await {
            log::error!("carbon pipeline: {err:?}");
        } else {
            log::warn!("carbon pipeline stopped");
        }
    });

    let served = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await
        .map_err(|err| err.to_string());
    logs_stop.cancel();
    served
}

/// Applies each `HZ_MATCH_RESOLVED` and `HZ_MATCH_CANCELLED` the program logged. The resolution or
/// cancel time is the block time of the log's slot, or null when the RPC has none.
async fn record_resolutions(
    db: Arc<Mutex<rusqlite::Connection>>,
    rpc_url: String,
    program_id: Pubkey,
    mut logs: tokio::sync::mpsc::Receiver<ProgramLogs>,
    stop: CancellationToken,
) {
    let rpc = RpcClient::new_with_timeout_and_commitment(rpc_url, Duration::from_secs(10), CommitmentConfig::confirmed());
    let program = program_id.to_string();
    while let Some(batch) = logs.recv().await {
        if batch.logs.last().is_some_and(|line| line == "Log truncated") {
            log::warn!(
                "logs of {} at slot {} are truncated; a resolution or cancellation past the cut is lost",
                batch.signature,
                batch.slot
            );
        }
        let found = decode::resolutions(&batch.logs, &program);
        let cancelled = decode::cancellations(&batch.logs, &program);
        if found.is_empty() && cancelled.is_empty() {
            continue;
        }
        let unix = block_time(&rpc, batch.slot).await;
        let Ok(conn) = db.lock() else {
            for (battle, outcome, fee, _) in &found {
                log::error!("resolution {battle} (outcome {outcome} fee {fee}) dropped: sqlite lock poisoned");
            }
            for battle in &cancelled {
                log::error!("cancellation {battle} dropped: sqlite lock poisoned");
            }
            continue;
        };
        for (battle, outcome, fee, seed) in found {
            match store::resolve(&conn, &battle, outcome, fee, &seed, unix) {
                Ok(()) => log::info!("battle {battle} resolved: outcome {outcome} fee {fee}"),
                Err(err) => log::error!("resolution {battle} (outcome {outcome} fee {fee}) dropped: {err}"),
            }
        }
        for battle in cancelled {
            match store::cancel(&conn, &battle, unix) {
                Ok(()) => log::info!("battle {battle} cancelled"),
                Err(err) => log::error!("cancellation {battle} dropped: {err}"),
            }
        }
    }
    if !stop.is_cancelled() {
        log::error!("resolution task stopped before shutdown: the logs channel closed");
    }
}

async fn prune_closed_armies(db: Arc<Mutex<rusqlite::Connection>>, rpc_url: String, program_id: Pubkey) {
    let rpc = RpcClient::new_with_timeout_and_commitment(rpc_url, Duration::from_secs(10), CommitmentConfig::confirmed());
    loop {
        tokio::time::sleep(PRUNE_EVERY).await;
        let keys = match db.lock().map_err(|_| "sqlite lock poisoned".to_string()).and_then(|conn| store::army_keys(&conn).map_err(|err| err.to_string())) {
            Ok(keys) => keys,
            Err(err) => {
                log::warn!("prune: {err}");
                continue;
            }
        };
        let mut gone = Vec::new();
        // The earliest slot any answer was read at: a row written later is a recreated account.
        let mut seen_slot = u64::MAX;
        for chunk in keys.chunks(100) {
            let pubkeys: Vec<Pubkey> = chunk.iter().filter_map(|key| key.parse().ok()).collect();
            match rpc.get_multiple_accounts_with_commitment(&pubkeys, CommitmentConfig::confirmed()).await {
                Ok(response) => {
                    seen_slot = seen_slot.min(response.context.slot);
                    for (pubkey, account) in pubkeys.iter().zip(response.value) {
                        let closed = account.is_none_or(|account| account.owner != program_id || account.data.is_empty());
                        if closed {
                            gone.push(pubkey.to_string());
                        }
                    }
                }
                Err(err) => {
                    log::warn!("prune getMultipleAccounts: {err}");
                    gone.clear();
                    break;
                }
            }
        }
        if gone.is_empty() {
            continue;
        }
        match db.lock() {
            Ok(conn) => match store::forget_armies(&conn, &gone, seen_slot) {
                Ok(count) => log::info!("prune: removed {count} closed armies"),
                Err(err) => log::warn!("prune: {err}"),
            },
            Err(_) => log::warn!("prune: sqlite lock poisoned"),
        }
    }
}

struct IndexProcessor {
    db: Arc<Mutex<rusqlite::Connection>>,
    rpc: RpcClient,
    /// Block times by slot. A slot the RPC could not time is remembered as None until
    /// `NO_TIME_FOR`, so a burst of updates in that slot does not wait out the retries each time.
    times: BTreeMap<u64, (Option<i64>, Instant)>,
}

impl Processor<AccountProcessorInputType<'_, HorizonAccount>> for IndexProcessor {
    async fn process(
        &mut self,
        data: &AccountProcessorInputType<'_, HorizonAccount>,
    ) -> CarbonResult<()> {
        let pubkey = data.metadata.pubkey.to_string();
        let slot = data.metadata.slot;
        let account = data.decoded_account.data.clone();
        let unix = self.block_time(slot).await;
        let conn = self
            .db
            .lock()
            .map_err(|_| carbon_core::error::Error::Custom("sqlite lock poisoned".to_string()))?;
        store::record(&conn, &pubkey, &account, slot, unix)
            .map_err(|err| carbon_core::error::Error::Custom(err.to_string()))?;
        Ok(())
    }
}

impl IndexProcessor {
    async fn block_time(&mut self, slot: u64) -> Option<i64> {
        if let Some(&(time, at)) = self.times.get(&slot) {
            if time.is_some() || at.elapsed() < NO_TIME_FOR {
                return time;
            }
        }
        if let Some(time) = near_time(&self.times, slot) {
            return Some(time);
        }
        let time = block_time(&self.rpc, slot).await;
        if self.times.len() >= TIMES_KEPT {
            self.times.clear();
        }
        self.times.insert(slot, (time, Instant::now()));
        time
    }
}

/// The time of the nearest slot already timed, when one is within `NEAR_SLOTS` of `slot`. Each slot
/// that misses waits on `getBlockTime`, with retries, before its update is stored; a few slots
/// apart the time differs by about a second on the rollup, so the cached one stands in.
fn near_time(times: &BTreeMap<u64, (Option<i64>, Instant)>, slot: u64) -> Option<i64> {
    times
        .range(slot.saturating_sub(NEAR_SLOTS)..=slot.saturating_add(NEAR_SLOTS))
        .filter_map(|(&near, &(time, _))| time.map(|time| (near.abs_diff(slot), time)))
        .min_by_key(|&(distance, _)| distance)
        .map(|(_, time)| time)
}

/// How far, in slots, a cached block time stands in for a slot not asked for.
const NEAR_SLOTS: u64 = 20;
/// How long a slot the RPC could not time is not asked again.
const NO_TIME_FOR: Duration = Duration::from_secs(30);
/// The block-time cache is cleared when it holds this many slots.
const TIMES_KEPT: usize = 10_000;
/// How often, and how far apart, a slot's block time is asked for before the row keeps a null time.
const BLOCK_TIME_TRIES: u32 = 5;
const BLOCK_TIME_RETRY: Duration = Duration::from_millis(200);

/// The block time of `slot`, or None when the RPC still has none after a few tries. The rollup
/// answers "not yet available" for about 100 ms after a slot, which is when a live update arrives.
async fn block_time(rpc: &RpcClient, slot: u64) -> Option<i64> {
    for attempt in 1..=BLOCK_TIME_TRIES {
        match rpc.get_block_time(slot).await {
            Ok(time) => return Some(time),
            Err(err) if attempt == BLOCK_TIME_TRIES => {
                log::warn!("no block time for slot {slot}: {err}");
            }
            Err(_) => tokio::time::sleep(BLOCK_TIME_RETRY).await,
        }
    }
    None
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("sigterm handler");
        tokio::select! {
            _ = ctrl_c => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    ctrl_c.await;
    log::info!("indexer shutting down");
}

impl Config {
    fn load(repo: &Path, file: &EnvFile) -> Result<Self, String> {
        let rpc_url =
            lookup(file, "SOLANA_RPC_URL").unwrap_or_else(|| "http://127.0.0.1:7799".to_string());
        let program = lookup(file, "PROGRAM_ID").unwrap_or_else(|| PROGRAM_ID.to_string());
        let program_id = program
            .parse::<Pubkey>()
            .map_err(|err| format!("PROGRAM_ID: {err}"))?;
        let database_path = match lookup(file, "DATABASE_PATH") {
            Some(value) => {
                let path = PathBuf::from(&value);
                if path.is_absolute() {
                    path
                } else {
                    repo.join(path)
                }
            }
            None => repo.join("indexer/data/horizon.db"),
        };
        let port = listen_port(file)?;
        Ok(Self {
            rpc_url,
            program_id,
            database_path,
            port,
        })
    }
}

struct EnvFile {
    values: HashMap<String, String>,
}

impl EnvFile {
    fn get(&self, key: &str) -> Option<&String> {
        self.values.get(key)
    }
}

fn listen_port(file: &EnvFile) -> Result<u16, String> {
    for key in ["INDEXER_PORT", "PORT"] {
        if let Some(value) = lookup(file, key) {
            return value.parse::<u16>().map_err(|_| format!("{key}: {value}"));
        }
    }
    Ok(4714)
}

fn lookup(file: &EnvFile, key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| file.get(key).cloned())
}

fn load_env_file(path: &Path) -> EnvFile {
    let mut values = HashMap::new();
    let Ok(text) = std::fs::read_to_string(path) else {
        return EnvFile { values };
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || std::env::var_os(key).is_some() {
            continue;
        }
        let value = value.trim();
        let value = if value.len() >= 2 {
            let bytes = value.as_bytes();
            let quoted = (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
                || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'');
            if quoted {
                &value[1..value.len() - 1]
            } else {
                value
            }
        } else {
            value
        };
        values.insert(key.to_string(), value.to_string());
    }
    EnvFile { values }
}

fn find_repo_root() -> PathBuf {
    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    loop {
        if dir.join("render.yaml").is_file() && dir.join(".env.example").is_file() {
            return dir;
        }
        if !dir.pop() {
            return std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        }
    }
}

/// Convert an HTTP RPC URL into the websocket URL Carbon's program subscribe uses.
pub fn rpc_to_ws(rpc: &str) -> String {
    let Some(scheme_end) = rpc.find("://") else {
        return rpc.to_string();
    };
    let scheme = &rpc[..scheme_end];
    let (ws_scheme, shift) = match scheme {
        "http" => ("ws", true),
        "https" => ("wss", true),
        "ws" | "wss" => (scheme, false),
        _ => return rpc.to_string(),
    };
    let rest = &rpc[scheme_end + 3..];
    if !shift {
        return format!("{ws_scheme}://{rest}");
    }
    let host_and_port = rest.split(['/', '?']).next().unwrap_or(rest);
    let mut suffix = &rest[host_and_port.len()..];
    if suffix == "/" {
        suffix = "";
    }
    let shifted = shift_port(host_and_port);
    format!("{ws_scheme}://{shifted}{suffix}")
}

fn shift_port(host_and_port: &str) -> String {
    if let Some(bracket) = host_and_port.find(']') {
        let after = &host_and_port[bracket + 1..];
        if let Some(port) = after
            .strip_prefix(':')
            .and_then(|value| value.parse::<u16>().ok())
        {
            return format!("{}:{}", &host_and_port[..=bracket], port.saturating_add(1));
        }
        return host_and_port.to_string();
    }
    if let Some((host, port)) = host_and_port.rsplit_once(':') {
        if let Ok(port) = port.parse::<u16>() {
            return format!("{host}:{}", port.saturating_add(1));
        }
    }
    host_and_port.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slot_near_a_timed_one_takes_its_time() {
        let mut times = BTreeMap::new();
        times.insert(100, (Some(1_000), Instant::now()));
        times.insert(130, (None, Instant::now()));
        times.insert(150, (Some(1_020), Instant::now()));
        assert_eq!(near_time(&times, 100), Some(1_000));
        assert_eq!(near_time(&times, 115), Some(1_000));
        assert_eq!(near_time(&times, 140), Some(1_020));
        assert_eq!(near_time(&times, 125), None, "an untimed slot does not count");
        assert_eq!(near_time(&times, 200), None);
    }

    #[test]
    fn websocket_url_matches_local_validator_and_public_rpc() {
        assert_eq!(rpc_to_ws("http://127.0.0.1:8899"), "ws://127.0.0.1:8900");
        assert_eq!(rpc_to_ws("http://127.0.0.1:8899/"), "ws://127.0.0.1:8900");
        assert_eq!(rpc_to_ws("http://127.0.0.1:7799"), "ws://127.0.0.1:7800");
        assert_eq!(
            rpc_to_ws("https://api.devnet.solana.com"),
            "wss://api.devnet.solana.com"
        );
        assert_eq!(rpc_to_ws("wss://example.com/rpc"), "wss://example.com/rpc");
    }

    #[test]
    fn env_file_does_not_override_existing_values() {
        let dir = std::env::temp_dir().join(format!("horizon-env-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "HORIZON_TEST_ENV_PRECEDENCE=from-file\nHORIZON_TEST_ENV_FILE_ONLY=9999\n",
        )
        .expect("write");
        let key = "HORIZON_TEST_ENV_PRECEDENCE";
        let previous = std::env::var(key).ok();
        // The process environment wins. This runs before the runtime starts other
        // work in this test, and the key is restored before the test returns.
        unsafe { std::env::set_var(key, "from-process") };
        let file = load_env_file(&path);
        assert!(file.get(key).is_none());
        assert_eq!(
            file.get("HORIZON_TEST_ENV_FILE_ONLY").map(String::as_str),
            Some("9999")
        );
        assert_eq!(lookup(&file, key).as_deref(), Some("from-process"));
        assert_eq!(
            lookup(&file, "HORIZON_TEST_ENV_FILE_ONLY").as_deref(),
            Some("9999")
        );
        unsafe {
            match previous {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        let _ = std::fs::remove_file(path);
    }
}
