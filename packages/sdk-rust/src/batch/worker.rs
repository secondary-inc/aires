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
        // The serialize pool is local state and cannot fail transiently — if it
        // can't be built the SDK is unusable, so bail.
        let pool = match SerializePool::new(&self.config) {
            Ok(p) => p,
            Err(e) => {
                tracing::error!("aires: failed to create serialize pool: {e}");
                return;
            }
        };

        // The collector connection is established lazily and re-established on
        // demand (see `ship`). A collector that is briefly down, or that starts
        // *after* the application, must NOT permanently disable telemetry — the
        // old code returned on the first connect error and silently dropped
        // everything forever. We keep the worker alive regardless.
        let mut client: Option<GrpcClient> = None;

        let mut buffer: Vec<Event> = Vec::with_capacity(self.config.batch_size);
        let mut tick = interval(self.config.batch_timeout);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = tick.tick() => {
                    if !buffer.is_empty() {
                        self.ship(&mut client, &pool, &mut buffer).await;
                    }
                }
                _ = self.flush_notify.notified() => {
                    self.drain_channel(&mut buffer);
                    if !buffer.is_empty() {
                        self.ship(&mut client, &pool, &mut buffer).await;
                    }
                    self.flush_done.notify_one();
                }
            }

            self.drain_channel(&mut buffer);

            if buffer.len() >= self.config.batch_size {
                self.ship(&mut client, &pool, &mut buffer).await;
            }
        }
    }

    /// Return a live client, connecting (or reconnecting) if we don't have one.
    /// Returns `None` if the collector is currently unreachable; the caller keeps
    /// the batch buffered so it can be retried on the next tick.
    async fn client<'a>(&self, slot: &'a mut Option<GrpcClient>) -> Option<&'a GrpcClient> {
        if slot.is_none() {
            match GrpcClient::connect(&self.config).await {
                Ok(c) => *slot = Some(c),
                Err(e) => {
                    tracing::warn!("aires: collector unreachable, will retry: {e}");
                    return None;
                }
            }
        }
        slot.as_ref()
    }

    fn drain_channel(&self, buffer: &mut Vec<Event>) {
        while let Ok(event) = self.rx.try_recv() {
            buffer.push(event);
            if buffer.len() >= self.config.batch_size {
                break;
            }
        }
    }

    async fn ship(
        &self,
        client: &mut Option<GrpcClient>,
        pool: &SerializePool,
        buffer: &mut Vec<Event>,
    ) {
        // Make sure we have a connection before we touch the buffer. If the
        // collector is unreachable we leave events buffered for the next tick
        // (capped by queue_capacity back-pressure upstream) rather than dropping.
        if self.client(client).await.is_none() {
            return;
        }

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
            // Re-resolve the client each attempt so a connection dropped by a
            // failed send is rebuilt before the next try.
            let conn = match self.client(client).await {
                Some(c) => c,
                None => {
                    // Lost the collector mid-flight and can't reconnect right now.
                    // Back off and retry within the retry budget.
                    retries += 1;
                    if retries > self.config.max_retries {
                        tracing::error!(
                            retries,
                            events = event_count,
                            "aires: dropping batch — collector unreachable after max retries"
                        );
                        break;
                    }
                    tokio::time::sleep(self.config.retry_backoff * retries).await;
                    continue;
                }
            };

            match conn.ingest_raw(payload.clone()).await {
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
                    // Drop the (possibly broken) channel so the next attempt
                    // forces a fresh connect rather than reusing a dead one.
                    *client = None;
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
