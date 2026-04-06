use crossbeam_channel::{Sender, TrySendError, bounded};
use std::sync::Arc;
use tokio::sync::Notify;

use super::worker::BatchWorker;
use crate::config::AiresConfig;
use crate::error::Result;
use crate::event::Event;

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
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use crossbeam_channel::bounded;

    use crate::event::Event;
    use crate::proto;

    fn make_event(msg: &str) -> Event {
        Event {
            inner: proto::Event {
                id: "test".into(),
                message: msg.into(),
                ..Default::default()
            },
        }
    }

    #[test]
    fn channel_accepts_events_up_to_capacity() {
        let (tx, _rx) = bounded::<Event>(4);
        assert!(tx.try_send(make_event("a")).is_ok());
        assert!(tx.try_send(make_event("b")).is_ok());
        assert!(tx.try_send(make_event("c")).is_ok());
        assert!(tx.try_send(make_event("d")).is_ok());
    }

    #[test]
    fn channel_rejects_when_full() {
        let (tx, _rx) = bounded::<Event>(2);
        assert!(tx.try_send(make_event("a")).is_ok());
        assert!(tx.try_send(make_event("b")).is_ok());
        assert!(tx.try_send(make_event("c")).is_err());
    }

    #[test]
    fn channel_drain_frees_capacity() {
        let (tx, rx) = bounded::<Event>(2);
        tx.try_send(make_event("a")).unwrap();
        tx.try_send(make_event("b")).unwrap();
        assert!(tx.try_send(make_event("c")).is_err());

        let _ = rx.try_recv().unwrap();
        assert!(tx.try_send(make_event("c")).is_ok());
    }

    #[test]
    fn channel_preserves_order() {
        let (tx, rx) = bounded::<Event>(8);
        tx.try_send(make_event("first")).unwrap();
        tx.try_send(make_event("second")).unwrap();
        tx.try_send(make_event("third")).unwrap();

        assert_eq!(rx.try_recv().unwrap().message(), "first");
        assert_eq!(rx.try_recv().unwrap().message(), "second");
        assert_eq!(rx.try_recv().unwrap().message(), "third");
    }

    #[test]
    fn disconnected_channel_reports_error() {
        let (tx, rx) = bounded::<Event>(4);
        drop(rx);
        assert!(tx.try_send(make_event("orphan")).is_err());
    }
}
