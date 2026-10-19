//! RPC account sources for the Carbon pipeline.
//!
//! `getProgramAccounts` sends one snapshot. `programSubscribe` streams later
//! updates, and after each successful (re)subscribe sends a fresh snapshot, so
//! an update missed while the websocket was down is not lost. A refused dial is
//! logged with the URL and tried again every few seconds until shutdown. The
//! pipeline stays up while the validator is down.
//!
//! `logsSubscribe` streams the logs of transactions that mention the program.
//! Carbon has no update type for bare logs, and a logs notification carries no
//! transaction to build one from, so this source is not a Carbon datasource: it
//! sends the logs of each successful transaction to its own channel. It dials
//! and retries the same way as `programSubscribe`.

use std::str::FromStr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use carbon_core::datasource::{AccountUpdate, Datasource, DatasourceId, Update, UpdateType};
use carbon_core::error::CarbonResult;
use futures_util::StreamExt;
use solana_client::nonblocking::pubsub_client::PubsubClient;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_config::{
    RpcAccountInfoConfig, RpcProgramAccountsConfig, RpcTransactionLogsConfig, RpcTransactionLogsFilter,
    UiAccountEncoding,
};
use solana_client::rpc_request::RpcRequest;
use solana_client::rpc_response::{OptionalContext, RpcKeyedAccount};
use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use tokio_util::sync::CancellationToken;

const RPC_RETRY: Duration = Duration::from_secs(3);
const RPC_TIMEOUT: Duration = Duration::from_secs(10);

/// Called with a snapshot's slot before its accounts are sent.
pub type SnapshotHook = Arc<dyn Fn(u64) + Send + Sync>;

pub struct ProgramSnapshot {
    rpc_url: String,
    program_id: Pubkey,
    on_snapshot: SnapshotHook,
    retry: Duration,
    failures: Arc<AtomicU32>,
}

pub struct ProgramSubscribe {
    ws_url: String,
    rpc_url: String,
    program_id: Pubkey,
    on_snapshot: SnapshotHook,
    retry: Duration,
    failures: Arc<AtomicU32>,
}

pub struct LogsSubscribe {
    ws_url: String,
    program_id: Pubkey,
    retry: Duration,
    failures: Arc<AtomicU32>,
}

/// The logs of one successful transaction that mentions the program.
pub struct ProgramLogs {
    pub signature: String,
    pub slot: u64,
    pub logs: Vec<String>,
}

impl ProgramSnapshot {
    pub fn new(rpc_url: String, program_id: Pubkey, on_snapshot: SnapshotHook) -> Self {
        Self {
            rpc_url,
            program_id,
            on_snapshot,
            retry: RPC_RETRY,
            failures: Arc::new(AtomicU32::new(0)),
        }
    }
}

impl ProgramSubscribe {
    pub fn new(ws_url: String, rpc_url: String, program_id: Pubkey, on_snapshot: SnapshotHook) -> Self {
        Self {
            ws_url,
            rpc_url,
            program_id,
            on_snapshot,
            retry: RPC_RETRY,
            failures: Arc::new(AtomicU32::new(0)),
        }
    }
}

impl LogsSubscribe {
    pub fn new(ws_url: String, program_id: Pubkey) -> Self {
        Self {
            ws_url,
            program_id,
            retry: RPC_RETRY,
            failures: Arc::new(AtomicU32::new(0)),
        }
    }

    /// Runs until `cancellation_token` fires or the receiver is dropped.
    pub async fn consume(
        &self,
        sender: tokio::sync::mpsc::Sender<ProgramLogs>,
        cancellation_token: CancellationToken,
    ) {
        loop {
            if cancellation_token.is_cancelled() {
                return;
            }
            let client = match PubsubClient::new(&self.ws_url).await {
                Ok(client) => client,
                Err(err) => {
                    self.failures.fetch_add(1, Ordering::Relaxed);
                    log::error!(
                        "Failed to create RPC logs client for {}: {err}; retrying",
                        self.ws_url
                    );
                    if pause(&cancellation_token, self.retry).await {
                        return;
                    }
                    continue;
                }
            };

            let filter = RpcTransactionLogsFilter::Mentions(vec![self.program_id.to_string()]);
            let config = RpcTransactionLogsConfig {
                commitment: Some(CommitmentConfig::confirmed()),
            };
            let (mut logs_stream, _unsub) = match client.logs_subscribe(filter, config).await {
                Ok(subscription) => subscription,
                Err(err) => {
                    self.failures.fetch_add(1, Ordering::Relaxed);
                    log::error!(
                        "Failed to subscribe to program logs on {}: {err}; retrying",
                        self.ws_url
                    );
                    if pause(&cancellation_token, self.retry).await {
                        return;
                    }
                    continue;
                }
            };

            loop {
                tokio::select! {
                    _ = cancellation_token.cancelled() => {
                        return;
                    }
                    event = logs_stream.next() => {
                        match event {
                            Some(event) => {
                                // A failed transaction changed nothing, whatever it logged first.
                                if event.value.err.is_some() {
                                    continue;
                                }
                                let logs = ProgramLogs {
                                    signature: event.value.signature,
                                    slot: event.context.slot,
                                    logs: event.value.logs,
                                };
                                if sender.send(logs).await.is_err() {
                                    return;
                                }
                            }
                            None => {
                                log::warn!(
                                    "Program logs stream {} closed; retrying",
                                    self.ws_url
                                );
                                break;
                            }
                        }
                    }
                }
            }

            if pause(&cancellation_token, self.retry).await {
                return;
            }
        }
    }
}

/// An account update for the pipeline. Not Carbon's `AccountUpdate::into_update`: it turns an
/// account with 0 lamports into a deletion, and every rollup ephemeral account (Army, Behavior,
/// Battle) holds 0 lamports, its rent sitting with the sponsor. A closed account does not reach this
/// point: `programSubscribe` stops reporting it, and the prune pass forgets closed armies.
fn account_update(pubkey: Pubkey, account: solana_account::Account, slot: u64) -> Update {
    Update::Account(AccountUpdate { pubkey, account, slot, transaction_signature: None })
}

/// Wait before the next dial. `true` means the indexer is shutting down.
async fn pause(token: &CancellationToken, retry: Duration) -> bool {
    tokio::select! {
        _ = token.cancelled() => true,
        _ = tokio::time::sleep(retry) => false,
    }
}

fn snapshot_client(rpc_url: &str) -> RpcClient {
    RpcClient::new_with_timeout_and_commitment(rpc_url.to_string(), RPC_TIMEOUT, CommitmentConfig::confirmed())
}

/// One `getProgramAccounts`: `on_snapshot` gets its slot, then every account goes to the pipeline as
/// an update at that slot. `Ok(true)` means the indexer is shutting down or the pipeline stopped.
async fn send_snapshot(
    rpc: &RpcClient,
    program_id: &Pubkey,
    on_snapshot: &SnapshotHook,
    id: &DatasourceId,
    sender: &tokio::sync::mpsc::Sender<(Update, DatasourceId)>,
    cancellation_token: &CancellationToken,
) -> Result<bool, String> {
    let config = RpcProgramAccountsConfig {
        with_context: Some(true),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            commitment: Some(CommitmentConfig::confirmed()),
            ..Default::default()
        },
        ..Default::default()
    };
    let params = serde_json::json!([program_id.to_string(), config]);
    let response = match rpc.send::<OptionalContext<Vec<RpcKeyedAccount>>>(RpcRequest::GetProgramAccounts, params).await {
        Ok(OptionalContext::Context(response)) => response,
        Ok(OptionalContext::NoContext(_)) => return Err("response had no slot".to_string()),
        Err(err) => return Err(err.to_string()),
    };
    log::info!(
        "Fetched {} accounts for program {} (slot: {})",
        response.value.len(),
        program_id,
        response.context.slot
    );
    on_snapshot(response.context.slot);
    for account in response.value {
        if cancellation_token.is_cancelled() {
            return Ok(true);
        }
        let Ok(pubkey) = Pubkey::from_str(&account.pubkey) else {
            log::error!("Error parsing account pubkey. Value: {}", account.pubkey);
            continue;
        };
        let Some(decoded) = account.account.to_account() else {
            log::error!("Error decoding account {}", account.pubkey);
            continue;
        };
        let update = account_update(pubkey, decoded, response.context.slot);
        if sender.send((update, id.clone())).await.is_err() {
            return Ok(true);
        }
    }
    Ok(false)
}

#[async_trait]
impl Datasource for ProgramSnapshot {
    async fn consume(
        &self,
        id: DatasourceId,
        sender: tokio::sync::mpsc::Sender<(Update, DatasourceId)>,
        cancellation_token: CancellationToken,
    ) -> CarbonResult<()> {
        let rpc = snapshot_client(&self.rpc_url);
        loop {
            if cancellation_token.is_cancelled() {
                return Ok(());
            }
            match send_snapshot(&rpc, &self.program_id, &self.on_snapshot, &id, &sender, &cancellation_token).await {
                Ok(_) => return Ok(()),
                Err(err) => {
                    self.failures.fetch_add(1, Ordering::Relaxed);
                    log::error!("getProgramAccounts {}: {err}; retrying", self.rpc_url);
                }
            }
            if pause(&cancellation_token, self.retry).await {
                return Ok(());
            }
        }
    }

    fn update_types(&self) -> Vec<UpdateType> {
        vec![UpdateType::AccountUpdate]
    }
}

#[async_trait]
impl Datasource for ProgramSubscribe {
    async fn consume(
        &self,
        id: DatasourceId,
        sender: tokio::sync::mpsc::Sender<(Update, DatasourceId)>,
        cancellation_token: CancellationToken,
    ) -> CarbonResult<()> {
        let rpc = snapshot_client(&self.rpc_url);
        loop {
            if cancellation_token.is_cancelled() {
                return Ok(());
            }
            let client = match PubsubClient::new(&self.ws_url).await {
                Ok(client) => client,
                Err(err) => {
                    self.failures.fetch_add(1, Ordering::Relaxed);
                    log::error!(
                        "Failed to create RPC subscribe client for {}: {err}; retrying",
                        self.ws_url
                    );
                    if pause(&cancellation_token, self.retry).await {
                        return Ok(());
                    }
                    continue;
                }
            };

            // Without an encoding the RPC sends base58, which it refuses for accounts over 128
            // bytes: every Battleground, Army and Battle arrived undecodable.
            let config = RpcProgramAccountsConfig {
                account_config: RpcAccountInfoConfig {
                    encoding: Some(UiAccountEncoding::Base64),
                    commitment: Some(CommitmentConfig::confirmed()),
                    ..Default::default()
                },
                ..Default::default()
            };
            let (mut program_stream, _unsub) =
                match client.program_subscribe(&self.program_id, Some(config)).await {
                    Ok(subscription) => subscription,
                    Err(err) => {
                        self.failures.fetch_add(1, Ordering::Relaxed);
                        log::error!(
                            "Failed to subscribe to program updates on {}: {err}; retrying",
                            self.ws_url
                        );
                        if pause(&cancellation_token, self.retry).await {
                            return Ok(());
                        }
                        continue;
                    }
                };

            // Anything that changed before the subscription took hold (a reconnect gap, or the
            // time since the startup snapshot) arrives in this snapshot. Notifications queue on
            // the subscription meanwhile. Updates carry their slot, so the order does not matter.
            match send_snapshot(&rpc, &self.program_id, &self.on_snapshot, &id, &sender, &cancellation_token).await {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(err) => {
                    self.failures.fetch_add(1, Ordering::Relaxed);
                    log::error!("getProgramAccounts {} after subscribing: {err}; subscribing again", self.rpc_url);
                    if pause(&cancellation_token, self.retry).await {
                        return Ok(());
                    }
                    continue;
                }
            }

            loop {
                tokio::select! {
                    _ = cancellation_token.cancelled() => {
                        return Ok(());
                    }
                    event_result = program_stream.next() => {
                        match event_result {
                            Some(event) => {
                                let Some(decoded) = event.value.account.to_account() else {
                                    log::error!("Error decoding account event");
                                    continue;
                                };
                                let Ok(pubkey) = Pubkey::from_str(&event.value.pubkey) else {
                                    log::error!("Error parsing account pubkey. Value: {}", event.value.pubkey);
                                    continue;
                                };
                                let update = account_update(pubkey, decoded, event.context.slot);
                                // Wait for room rather than drop an update; a closed channel
                                // means the pipeline has stopped.
                                if sender.send((update, id.clone())).await.is_err() {
                                    return Ok(());
                                }
                            }
                            None => {
                                log::warn!(
                                    "Program accounts stream {} closed; retrying",
                                    self.ws_url
                                );
                                break;
                            }
                        }
                    }
                }
            }

            if pause(&cancellation_token, self.retry).await {
                return Ok(());
            }
        }
    }

    fn update_types(&self) -> Vec<UpdateType> {
        // `account_update` never builds a deletion.
        vec![UpdateType::AccountUpdate]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ephemeral_account_with_no_lamports_is_an_update_not_a_deletion() {
        let account = solana_account::Account {
            lamports: 0,
            data: vec![1, 2, 3],
            owner: Pubkey::new_unique(),
            executable: false,
            rent_epoch: 0,
        };
        let update = account_update(Pubkey::new_unique(), account, 7);
        assert!(matches!(update, Update::Account(ref update) if update.slot == 7 && update.account.data == [1, 2, 3]));
    }

    async fn stays_up_until_cancel<D>(source: D, name: &str)
    where
        D: Datasource + 'static,
    {
        let (tx, _rx) = tokio::sync::mpsc::channel(4);
        let token = CancellationToken::new();
        let cancel = token.clone();
        let label = name.to_string();
        let task = tokio::spawn(async move {
            source
                .consume(DatasourceId::new_named(&label), tx, cancel)
                .await
        });
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            !task.is_finished(),
            "{name} stopped after connection failures"
        );
        token.cancel();
        let joined = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap_or_else(|_| panic!("{name} did not stop after cancel"));
        assert!(joined.expect("task panicked").is_ok());
    }

    #[tokio::test]
    async fn refused_snapshot_retries_until_shutdown() {
        let failures = Arc::new(AtomicU32::new(0));
        let source = ProgramSnapshot {
            rpc_url: "http://127.0.0.1:1".to_string(),
            program_id: Pubkey::from_str("11111111111111111111111111111111").unwrap(),
            on_snapshot: Arc::new(|_| {}),
            retry: Duration::from_millis(20),
            failures: Arc::clone(&failures),
        };
        stays_up_until_cancel(source, "snapshot-test").await;
        assert!(
            failures.load(Ordering::Relaxed) > 10,
            "snapshot dialed {} times",
            failures.load(Ordering::Relaxed)
        );
    }

    #[tokio::test]
    async fn refused_program_subscribe_retries_until_shutdown() {
        let failures = Arc::new(AtomicU32::new(0));
        let source = ProgramSubscribe {
            ws_url: "ws://127.0.0.1:1".to_string(),
            rpc_url: "http://127.0.0.1:1".to_string(),
            program_id: Pubkey::from_str("11111111111111111111111111111111").unwrap(),
            on_snapshot: Arc::new(|_| {}),
            retry: Duration::from_millis(20),
            failures: Arc::clone(&failures),
        };
        stays_up_until_cancel(source, "subscribe-test").await;
        assert!(
            failures.load(Ordering::Relaxed) > 10,
            "program subscribe dialed {} times",
            failures.load(Ordering::Relaxed)
        );
    }

    #[tokio::test]
    async fn refused_logs_subscribe_retries_until_shutdown() {
        let failures = Arc::new(AtomicU32::new(0));
        let source = LogsSubscribe {
            ws_url: "ws://127.0.0.1:1".to_string(),
            program_id: Pubkey::from_str("11111111111111111111111111111111").unwrap(),
            retry: Duration::from_millis(20),
            failures: Arc::clone(&failures),
        };
        let (tx, _rx) = tokio::sync::mpsc::channel(4);
        let token = CancellationToken::new();
        let cancel = token.clone();
        let task = tokio::spawn(async move { source.consume(tx, cancel).await });
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!task.is_finished(), "logs subscribe stopped after connection failures");
        token.cancel();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("logs subscribe did not stop after cancel")
            .expect("task panicked");
        assert!(
            failures.load(Ordering::Relaxed) > 10,
            "logs subscribe dialed {} times",
            failures.load(Ordering::Relaxed)
        );
    }
}
