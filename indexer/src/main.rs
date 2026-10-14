//! Horizon Zero indexer.
//!
//! Carbon's RPC block subscription emits transactions and block details, not
//! account updates, so this process does not use it and does not use Geyser.
//! `SOLANA_RPC_URL` is the MagicBlock ephemeral rollup's RPC: Armies, Behaviors
//! and Battles exist only there, and Battlegrounds and Players are delegated to it.
//! The pipeline's account decoder is fed by two RPC sources in this crate:
//! `getProgramAccounts` on `SOLANA_RPC_URL`, then WebSocket `programSubscribe`.
//! A third source, WebSocket `logsSubscribe`, reads `HZ_MATCH_RESOLVED`:
//! `settle_match` closes the battle, so the outcome and fee are only in that log.
//! A websocket URL is derived from the HTTP URL the same way the previous
//! client did: `http` becomes `ws`, `https` becomes `wss`, and an explicit
//! port is incremented by one so the local rollup `127.0.0.1:7799` is dialed
//! on 7800. A refused dial is logged and tried again every 3 seconds until
//! this process shuts down. The pipeline stays up.
//!
//! Account updates carry a slot. Block time is `getBlockTime` for that slot.
//! If the RPC has no time, the row is stored with a null timestamp.
//!
//! `close_army` hands the account back to the System Program, and
//! `programSubscribe` only reports accounts the program still owns, so a
//! closed army never arrives as an update. Every `PRUNE_EVERY` the indexer
//! reads its stored armies with `getMultipleAccounts` and deletes the rows
//! whose account is gone or no longer owned by the program.

mod decode;
mod http;
mod sources;
mod store;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use carbon_core::account::AccountProcessorInputType;
use carbon_core::error::CarbonResult;
use carbon_core::processor::Processor;
use carbon_log_metrics::LogMetrics;
use decode::{HorizonAccount, HorizonDecoder, PROGRAM_ID};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use sources::{LogsSubscribe, ProgramLogs, ProgramSnapshot, ProgramSubscribe};
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
        times: HashMap::new(),
    };
    let mut pipeline = carbon_core::pipeline::Pipeline::builder()
        .datasource(ProgramSnapshot::new(
            config.rpc_url.clone(),
            config.program_id,
        ))
        .datasource(ProgramSubscribe::new(ws_url.clone(), config.program_id))
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
    tokio::spawn(async move { logs_source.consume(logs_tx, logs_cancel).await });
    tokio::spawn(record_resolutions(
        Arc::clone(&db),
        config.rpc_url.clone(),
        config.program_id,
        logs_rx,
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

/// Applies each `HZ_MATCH_RESOLVED` the program logged. The resolution time is the block time of
/// the log's slot, or null when the RPC has none.
async fn record_resolutions(
    db: Arc<Mutex<rusqlite::Connection>>,
    rpc_url: String,
    program_id: Pubkey,
    mut logs: tokio::sync::mpsc::Receiver<ProgramLogs>,
) {
    let rpc = RpcClient::new_with_timeout_and_commitment(rpc_url, Duration::from_secs(10), CommitmentConfig::confirmed());
    let program = program_id.to_string();
    while let Some(batch) = logs.recv().await {
        let found = decode::resolutions(&batch.logs, &program);
        if found.is_empty() {
            continue;
        }
        let unix = match rpc.get_block_time(batch.slot).await {
            Ok(time) => Some(time),
            Err(err) => {
                log::warn!("no block time for slot {}: {err}", batch.slot);
                None
            }
        };
        let Ok(conn) = db.lock() else {
            log::warn!("resolution: sqlite lock poisoned");
            continue;
        };
        for (battle, outcome, fee) in found {
            match store::resolve(&conn, &battle, outcome, fee, unix) {
                Ok(()) => log::info!("battle {battle} resolved: outcome {outcome} fee {fee}"),
                Err(err) => log::warn!("resolution {battle}: {err}"),
            }
        }
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
        for chunk in keys.chunks(100) {
            let pubkeys: Vec<Pubkey> = chunk.iter().filter_map(|key| key.parse().ok()).collect();
            match rpc.get_multiple_accounts(&pubkeys).await {
                Ok(accounts) => {
                    for (pubkey, account) in pubkeys.iter().zip(accounts) {
                        let closed = account.map_or(true, |account| account.owner != program_id || account.data.is_empty());
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
            Ok(conn) => match store::forget_armies(&conn, &gone) {
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
    times: HashMap<u64, i64>,
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
        store::record(&conn, &pubkey, &account, unix)
            .map_err(|err| carbon_core::error::Error::Custom(err.to_string()))?;
        Ok(())
    }
}

impl IndexProcessor {
    async fn block_time(&mut self, slot: u64) -> Option<i64> {
        if let Some(time) = self.times.get(&slot).copied() {
            return Some(time);
        }
        match self.rpc.get_block_time(slot).await {
            Ok(time) => {
                self.times.insert(slot, time);
                Some(time)
            }
            Err(err) => {
                log::warn!("no block time for slot {slot}: {err}");
                None
            }
        }
    }
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
