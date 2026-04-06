use std::time::Duration;

use crate::error::{Error, Result};

#[derive(Debug, Clone)]
pub struct AiresConfig {
    pub(crate) service: String,
    pub(crate) environment: String,
    pub(crate) endpoint: String,
    pub(crate) batch_size: usize,
    pub(crate) batch_timeout: Duration,
    pub(crate) queue_capacity: usize,
    pub(crate) flush_timeout: Duration,
    pub(crate) tls: bool,
    pub(crate) api_key: Option<String>,
    pub(crate) max_retries: u32,
    pub(crate) retry_backoff: Duration,
}

impl AiresConfig {
    pub fn service(&self) -> &str {
        &self.service
    }
    pub fn environment(&self) -> &str {
        &self.environment
    }
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }
}

pub struct AiresConfigBuilder {
    service: Option<String>,
    environment: Option<String>,
    endpoint: Option<String>,
    batch_size: usize,
    batch_timeout: Duration,
    queue_capacity: usize,
    flush_timeout: Duration,
    tls: bool,
    api_key: Option<String>,
    max_retries: u32,
    retry_backoff: Duration,
}

impl AiresConfigBuilder {
    pub fn new() -> Self {
        Self {
            service: None,
            environment: None,
            endpoint: None,
            batch_size: 256,
            batch_timeout: Duration::from_millis(500),
            queue_capacity: 8192,
            flush_timeout: Duration::from_secs(5),
            tls: true,
            api_key: None,
            max_retries: 3,
            retry_backoff: Duration::from_millis(100),
        }
    }

    pub fn service(mut self, name: impl Into<String>) -> Self {
        self.service = Some(name.into());
        self
    }

    pub fn environment(mut self, env: impl Into<String>) -> Self {
        self.environment = Some(env.into());
        self
    }

    pub fn endpoint(mut self, url: impl Into<String>) -> Self {
        self.endpoint = Some(url.into());
        self
    }

    pub fn batch_size(mut self, n: usize) -> Self {
        self.batch_size = n;
        self
    }

    pub fn batch_timeout(mut self, d: Duration) -> Self {
        self.batch_timeout = d;
        self
    }

    pub fn queue_capacity(mut self, n: usize) -> Self {
        self.queue_capacity = n;
        self
    }

    pub fn flush_timeout(mut self, d: Duration) -> Self {
        self.flush_timeout = d;
        self
    }

    pub fn tls(mut self, enabled: bool) -> Self {
        self.tls = enabled;
        self
    }

    pub fn api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = n;
        self
    }

    pub fn retry_backoff(mut self, d: Duration) -> Self {
        self.retry_backoff = d;
        self
    }

    pub fn build(self) -> Result<AiresConfig> {
        let service = self
            .service
            .ok_or_else(|| Error::Config("service name is required".into()))?;

        let endpoint = self
            .endpoint
            .ok_or_else(|| Error::Config("collector endpoint is required".into()))?;

        if self.batch_size == 0 {
            return Err(Error::Config("batch_size must be > 0".into()));
        }

        if self.queue_capacity < self.batch_size {
            return Err(Error::Config("queue_capacity must be >= batch_size".into()));
        }

        Ok(AiresConfig {
            service,
            environment: self.environment.unwrap_or_else(|| "production".into()),
            endpoint,
            batch_size: self.batch_size,
            batch_timeout: self.batch_timeout,
            queue_capacity: self.queue_capacity,
            flush_timeout: self.flush_timeout,
            tls: self.tls,
            api_key: self.api_key,
            max_retries: self.max_retries,
            retry_backoff: self.retry_backoff,
        })
    }
}

impl Default for AiresConfigBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_requires_service() {
        let err = AiresConfigBuilder::new()
            .endpoint("http://localhost:4317")
            .build()
            .unwrap_err();

        assert!(err.to_string().contains("service name"));
    }

    #[test]
    fn builder_requires_endpoint() {
        let err = AiresConfigBuilder::new()
            .service("test")
            .build()
            .unwrap_err();

        assert!(err.to_string().contains("endpoint"));
    }

    #[test]
    fn builder_defaults() {
        let config = AiresConfigBuilder::new()
            .service("test")
            .endpoint("http://localhost:4317")
            .build()
            .unwrap();

        assert_eq!(config.service(), "test");
        assert_eq!(config.environment(), "production");
        assert_eq!(config.batch_size, 256);
        assert_eq!(config.queue_capacity, 8192);
    }

    #[test]
    fn builder_rejects_zero_batch() {
        let err = AiresConfigBuilder::new()
            .service("test")
            .endpoint("http://localhost:4317")
            .batch_size(0)
            .build()
            .unwrap_err();

        assert!(err.to_string().contains("batch_size"));
    }
}
