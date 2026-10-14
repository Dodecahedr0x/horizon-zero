//! RPC account sources for the Carbon pipeline.
//!
//! `getProgramAccounts` sends one snapshot. `programSubscribe` streams later
//! updates. A refused dial is logged with the URL and tried again every few
//! seconds until shutdown. The pipeline stays up while the validator is down.
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

pub struct ProgramSnapshot {
    rpc_url: String,
    program_id: Pubkey,
    retry: Duration,
    failures: Arc<AtomicU32>,
}

pub struct ProgramSubscribe {
    ws_url: String,
    program_id: Pubkey,
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
    pub slot: u64,
    pub logs: Vec<String>,
}

impl ProgramSnapshot {
    pub fn new(rpc_url: String, program_id: Pubkey) -> Self {
        Self {
            rpc_url,
            program_id,
            retry: RPC_RETRY,
            failures: Arc::new(AtomicU32::new(0)),
        }
    }
}

impl ProgramSubscribe {
    pub fn new(ws_url: String, program_id: Pubkey) -> Self {
        Self {
            ws_url,
            program_id,
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

/// Wait before the next dial. `true` means the indexer is shutting down.
async fn pause(token: &CancellationToken, retry: Duration) -> bool {
    tokio::select! {
        _ = token.cancelled() => true,
        _ = tokio::time::sleep(retry) => false,
    }
}

#[async_trait]
impl Datasource for ProgramSnapshot {
    async fn consume(
        &self,
        id: DatasourceId,
        sender: tokio::sync::mpsc::Sender<(Update, DatasourceId)>,
        cancellation_token: CancellationToken,
    ) -> CarbonResult<()> {
        let rpc = RpcClient::new_with_timeout_and_commitment(
            self.rpc_url.clone(),
            RPC_TIMEOUT,
            CommitmentConfig::confirmed(),
        );
        let config = RpcProgramAccountsConfig {
            with_context: Some(true),
            account_config: RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::Base64),
                commitment: Some(CommitmentConfig::confirmed()),
                ..Default::default()
            },
            ..Default::default()
        };
        let params = serde_json::json!([self.program_id.to_string(), config]);

        loop {
            if cancellation_token.is_cancelled() {
                return Ok(());
            }
            match rpc
                .send::<OptionalContext<Vec<RpcKeyedAccount>>>(
                    RpcRequest::GetProgramAccounts,
                    params.clone(),
                )
                .await
            {
                Ok(OptionalContext::Context(response)) => {
                    log::info!(
                        "Fetched {} accounts for program {} (slot: {})",
                        response.value.len(),
                        self.program_id,
                        response.context.slot
                    );
                    for account in response.value {
                        if cancellation_token.is_cancelled() {
                            return Ok(());
                        }
                        let Ok(pubkey) = Pubkey::from_str(&account.pubkey) else {
                            log::error!("Error parsing account pubkey. Value: {}", account.pubkey);
                            continue;
                        };
                        let Some(decoded) = account.account.to_account() else {
                            log::error!("Error decoding account {}", account.pubkey);
                            continue;
                        };
                        let update = AccountUpdate {
                            pubkey,
                            account: decoded,
                            slot: response.context.slot,
                            transaction_signature: None,
                        }
                        .into_update();
                        if sender.send((update, id.clone())).await.is_err() {
                            return Ok(());
                        }
                    }
                    return Ok(());
                }
                Ok(OptionalContext::NoContext(_)) => {
                    log::error!(
                        "getProgramAccounts {}: response had no slot; retrying",
                        self.rpc_url
                    );
                }
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

            let (mut program_stream, _unsub) =
                match client.program_subscribe(&self.program_id, None).await {
                    Ok(subscription) => subscription,
                    Err(err) => {
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
                                let update = AccountUpdate {
                                    pubkey,
                                    account: decoded,
                                    slot: event.context.slot,
                                    transaction_signature: None,
                                }
                                .into_update();
                                if sender.try_send((update, id.clone())).is_err() {
                                    log::error!("Error sending account update");
                                    break;
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
        vec![UpdateType::AccountUpdate, UpdateType::AccountDeletion]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            program_id: Pubkey::from_str("11111111111111111111111111111111").unwrap(),
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
