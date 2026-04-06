use crossbeam_channel::{Sender, bounded, TrySendError};
use tokio::sync::Notify;
use std::sync::Arc;

use crate::config::AiresConfig;
use crate::error::Result;
use crate::event::Event;
use super::worker::BatchWorker;

pub struct BatchSender {
    tx: Sender<Event>,
    flush_notify: Arc<Notify>,
    flush_done: Arc<Notify>,
    _worker_handle: Option<tokio::task::JoinHandle<()>>,
}

impl BatchSender {
    pub fn new(config: &AiresConfig) -> Result<Self> {
        let (tx, rx) = bounded::<Event>(config.queue_capacity);
        let flush_notify = Arc::new(Notify::new());
        let flush_done = Arc::new(Notify::new());

        let worker = BatchWorker {
            rx,
            config: config.clone(),
            flush_notify: flush_notify.clone(),
            flush_done: flush_done.clone(),
        };

        let handle = tokio::spawn(worker.run());

        Ok(Self {
            tx,
            flush_notify,
            flush_done,
            _worker_handle: Some(handle),
        })
    }

    pub fn submit(&self, event: Event) {
        match self.tx.try_send(event) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                tracing::warn!("aires batch queue full, dropping event");
            }
            Err(TrySendError::Disconnected(_)) => {
                tracing::error!("aires batch worker disconnected");
            }
        }
    }

    pub async fn flush(&self) {
        self.flush_notify.notify_one();
        self.flush_done.notified().await;
    }

    pub fn flush_sync(&self) {
        self.flush_notify.notify_one();
        // Best-effort: give the worker a moment to drain
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}
