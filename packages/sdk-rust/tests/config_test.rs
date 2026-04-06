use aires_sdk::{AiresConfig, AiresConfigBuilder};
use std::time::Duration;

#[test]
fn full_config_builder_chain() {
    let config = AiresConfigBuilder::new()
        .service("integration-test")
        .endpoint("http://localhost:4317")
        .environment("test")
        .batch_size(128)
        .batch_timeout(Duration::from_millis(250))
        .queue_capacity(4096)
        .flush_timeout(Duration::from_secs(3))
        .tls(false)
        .api_key("test-key-123")
        .max_retries(5)
        .retry_backoff(Duration::from_millis(50))
        .build()
        .expect("config should build");

    assert_eq!(config.service(), "integration-test");
    assert_eq!(config.environment(), "test");
    assert_eq!(config.endpoint(), "http://localhost:4317");
}

#[test]
fn config_queue_must_be_gte_batch() {
    let err = AiresConfigBuilder::new()
        .service("test")
        .endpoint("http://localhost:4317")
        .batch_size(100)
        .queue_capacity(50)
        .build()
        .unwrap_err();

    assert!(err.to_string().contains("queue_capacity"));
}

#[test]
fn multiple_configs_are_independent() {
    let a = AiresConfigBuilder::new()
        .service("svc-a")
        .endpoint("http://a:4317")
        .build()
        .unwrap();

    let b = AiresConfigBuilder::new()
        .service("svc-b")
        .endpoint("http://b:4317")
        .environment("staging")
        .build()
        .unwrap();

    assert_eq!(a.service(), "svc-a");
    assert_eq!(b.service(), "svc-b");
    assert_eq!(a.environment(), "production");
    assert_eq!(b.environment(), "staging");
}
