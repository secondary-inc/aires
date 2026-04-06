pub mod client;
pub mod batch;
pub mod config;
pub mod error;
pub mod event;

mod proto {
    tonic::include_proto!("aires.v1");
}

pub use config::{AiresConfig, AiresConfigBuilder};
pub use error::{Error, Result};
pub use event::{Event, EventBuilder, Severity};

use batch::BatchSender;

pub struct Aires {
    config: AiresConfig,
    sender: BatchSender,
}

impl Aires {
    pub fn builder() -> AiresConfigBuilder {
        AiresConfigBuilder::new()
    }

    pub fn from_config(config: AiresConfig) -> Result<Self> {
        let sender = BatchSender::new(&config)?;
        Ok(Self { config, sender })
    }

    pub fn log(&self, severity: Severity, message: impl Into<String>) -> EventBuilder<'_> {
        EventBuilder::new(self, severity, message.into())
    }

    pub fn trace(&self, message: impl Into<String>) -> EventBuilder<'_> {
        self.log(Severity::Trace, message)
    }

    pub fn debug(&self, message: impl Into<String>) -> EventBuilder<'_> {
        self.log(Severity::Debug, message)
    }

    pub fn info(&self, message: impl Into<String>) -> EventBuilder<'_> {
        self.log(Severity::Info, message)
    }

    pub fn warn(&self, message: impl Into<String>) -> EventBuilder<'_> {
        self.log(Severity::Warn, message)
    }

    pub fn error(&self, message: impl Into<String>) -> EventBuilder<'_> {
        self.log(Severity::Error, message)
    }

    pub fn fatal(&self, message: impl Into<String>) -> EventBuilder<'_> {
        self.log(Severity::Fatal, message)
    }

    pub fn span(&self, name: impl Into<String>) -> EventBuilder<'_> {
        EventBuilder::span(self, name.into())
    }

    pub fn metric(&self, name: impl Into<String>, value: f64) -> EventBuilder<'_> {
        EventBuilder::metric(self, name.into(), value)
    }

    pub(crate) fn submit(&self, event: Event) {
        self.sender.submit(event)
    }

    pub async fn flush(&self) {
        self.sender.flush().await
    }

    pub fn config(&self) -> &AiresConfig {
        &self.config
    }
}

impl Drop for Aires {
    fn drop(&mut self) {
        self.sender.flush_sync()
    }
}
