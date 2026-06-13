use std::time::Duration;

use crate::error::{Error, Result};

#[derive(Debug, Clone)]
#[allow(dead_code)]
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
    /// `None` = derive from the endpoint scheme (`https://` → on, `http://` → off).
    /// `Some(_)` = caller has explicitly opted in/out and we honor it verbatim.
    tls: Option<bool>,
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
            tls: None,
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
        self.tls = Some(enabled);
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

        // Resolve TLS. If the caller didn't explicitly choose, derive it from the
        // endpoint scheme like every other gRPC client does: `https://` ⇒ TLS,
        // anything else (`http://`, bare host) ⇒ plaintext h2c. Defaulting to TLS
        // unconditionally was silently breaking every plaintext `http://collector`
        // deployment — the handshake failed and the batch worker died on connect.
        let tls = self.tls.unwrap_or_else(|| tls_from_endpoint(&endpoint));

        Ok(AiresConfig {
            service,
            environment: self.environment.unwrap_or_else(|| "production".into()),
            endpoint,
            batch_size: self.batch_size,
            batch_timeout: self.batch_timeout,
            queue_capacity: self.queue_capacity,
            flush_timeout: self.flush_timeout,
            tls,
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

/// Decide whether to use TLS based purely on the endpoint URL scheme.
/// Only an explicit `https://` prefix enables TLS; `http://` and schemeless
/// endpoints (e.g. `collector:4317`, `localhost:4317`) use plaintext h2c.
pub(crate) fn tls_from_endpoint(endpoint: &str) -> bool {
    endpoint
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("https://")
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

    #[test]
    fn tls_derived_off_for_http_endpoint() {
        let config = AiresConfigBuilder::new()
            .service("test")
            .endpoint("http://collector.aires.svc.cluster.local:4317")
            .build()
            .unwrap();

        assert!(!config.tls, "http:// endpoints must use plaintext");
    }

    #[test]
    fn tls_derived_on_for_https_endpoint() {
        let config = AiresConfigBuilder::new()
            .service("test")
            .endpoint("https://collector.example.com:443")
            .build()
            .unwrap();

        assert!(config.tls, "https:// endpoints must use TLS");
    }

    #[test]
    fn tls_derived_off_for_schemeless_endpoint() {
        let config = AiresConfigBuilder::new()
            .service("test")
            .endpoint("collector:4317")
            .build()
            .unwrap();

        assert!(!config.tls, "schemeless endpoints default to plaintext");
    }

    #[test]
    fn explicit_tls_overrides_scheme() {
        // Caller can still force TLS on a non-https endpoint if they really want.
        let on = AiresConfigBuilder::new()
            .service("test")
            .endpoint("http://collector:4317")
            .tls(true)
            .build()
            .unwrap();
        assert!(on.tls);

        // ...and force plaintext on an https endpoint.
        let off = AiresConfigBuilder::new()
            .service("test")
            .endpoint("https://collector:4317")
            .tls(false)
            .build()
            .unwrap();
        assert!(!off.tls);
    }

    #[test]
    fn tls_from_endpoint_helper() {
        assert!(tls_from_endpoint("https://x:443"));
        assert!(tls_from_endpoint("HTTPS://x:443"));
        assert!(!tls_from_endpoint("http://x:4317"));
        assert!(!tls_from_endpoint("x:4317"));
        assert!(!tls_from_endpoint("localhost:4317"));
    }
}
