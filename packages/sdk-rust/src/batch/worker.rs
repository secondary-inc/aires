use crossbeam_channel::Receiver;
use std::sync::Arc;
use tokio::sync::Notify;
use tokio::time::interval;

use super::pool::SerializePool;
use crate::client::GrpcClient;
use crate::config::AiresConfig;
use crate::event::Event;
use crate::proto;

pub(crate) struct BatchWorker {
    pub rx: Receiver<Event>,
    pub config: AiresConfig,
    pub flush_notify: Arc<Notify>,
    pub flush_done: Arc<Notify>,
}

impl BatchWorker {
    pub async fn run(self) {
        let client = match GrpcClient::connect(&self.config).await {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("aires: failed to connect to collector: {e}");
                return;
            }
        };

        let pool = match SerializePool::new(&self.config) {
            Ok(p) => p,
            Err(e) => {
                tracing::error!("aires: failed to create serialize pool: {e}");
                return;
            }
        };

        let mut buffer: Vec<Event> = Vec::with_capacity(self.config.batch_size);
        let mut tick = interval(self.config.batch_timeout);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = tick.tick() => {
                    if !buffer.is_empty() {
                        self.ship(&client, &pool, &mut buffer).await;
                    }
                }
                _ = self.flush_notify.notified() => {
                    self.drain_channel(&mut buffer);
                    if !buffer.is_empty() {
                        self.ship(&client, &pool, &mut buffer).await;
                    }
                    self.flush_done.notify_one();
                }
            }

            self.drain_channel(&mut buffer);

            if buffer.len() >= self.config.batch_size {
                self.ship(&client, &pool, &mut buffer).await;
            }
        }
    }

    fn drain_channel(&self, buffer: &mut Vec<Event>) {
        while let Ok(event) = self.rx.try_recv() {
            buffer.push(event);
            if buffer.len() >= self.config.batch_size {
                break;
            }
        }
    }

    async fn ship(&self, client: &GrpcClient, pool: &SerializePool, buffer: &mut Vec<Event>) {
        let events: Vec<proto::Event> = buffer.drain(..).map(|e| e.into_proto()).collect();

        let batch = proto::EventBatch {
            events,
            sdk_name: "aires-sdk-rust".into(),
            sdk_version: env!("CARGO_PKG_VERSION").into(),
            sdk_language: "rust".into(),
        };

        // Serialize into arena-backed buffer (lock-free, no global allocator contention)
        let payload = match pool.serialize_batch(&batch) {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::error!(error = %e, "aires: failed to serialize batch");
                return;
            }
        };

        let event_count = batch.events.len();

        let mut retries = 0u32;
        loop {
            match client.ingest_raw(payload.clone()).await {
                Ok(resp) => {
                    if resp.rejected > 0 {
                        tracing::warn!(
                            accepted = resp.accepted,
                            rejected = resp.rejected,
                            "aires: some events rejected"
                        );
                    }
                    break;
                }
                Err(e) => {
                    retries += 1;
                    if retries > self.config.max_retries {
                        tracing::error!(
                            retries,
                            error = %e,
                            events = event_count,
                            "aires: dropping batch after max retries"
                        );
                        break;
                    }
                    let backoff = self.config.retry_backoff * retries;
                    tracing::warn!(
                        retry = retries,
                        backoff_ms = backoff.as_millis(),
                        error = %e,
                        "aires: retrying batch"
                    );
                    tokio::time::sleep(backoff).await;
                }
            }
        }
    }
}
