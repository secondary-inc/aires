---
title: "Rust SDK: Configuration"
description: All configuration options for the Aires Rust SDK — service, endpoint, batching, TLS, retries, and more.
---

## Configuration Builder

The `AiresConfigBuilder` is the entry point for all configuration. It uses a builder pattern with sensible defaults:

```rust
use std::time::Duration;
use aires_sdk::Aires;

let config = Aires::builder()
    .service("my-service")
    .endpoint("http://localhost:4317")
    .environment("production")
    .batch_size(256)
    .batch_timeout(Duration::from_millis(500))
    .queue_capacity(8192)
    .flush_timeout(Duration::from_secs(5))
    .tls(true)
    .api_key("sk-aires-xxxx")
    .max_retries(3)
    .retry_backoff(Duration::from_millis(100))
    .build()
    .expect("invalid config");

let aires = Aires::from_config(config).expect("failed to create client");
```

## Options Reference

### Required Options

| Option | Type | Description |
|--------|------|-------------|
| `service` | `String` | **Required.** The service name identifies your application in all events. Examples: `"workforce-api"`, `"billing-worker"`, `"auth-service"`. |
| `endpoint` | `String` | **Required.** The collector's gRPC endpoint. Examples: `"http://localhost:4317"`, `"https://collector.prod.internal:4317"`. |

### Identity

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `environment` | `String` | `"production"` | Environment name. Set to `"staging"`, `"dev"`, `"test"`, etc. Used for filtering events and preventing cross-environment pollution. |

### Batching

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `batch_size` | `usize` | `256` | Maximum events per batch. When the buffer reaches this count, the batch is shipped immediately. Must be > 0. |
| `batch_timeout` | `Duration` | `500ms` | Maximum time to wait before shipping a partial batch. Even if `batch_size` hasn't been reached, the batch is shipped after this interval. |
| `queue_capacity` | `usize` | `8192` | Maximum events buffered in the channel between the application and the batch worker. Must be >= `batch_size`. If the queue is full, new events are dropped. |
| `flush_timeout` | `Duration` | `5s` | Maximum time to wait when flushing remaining events at shutdown. If the flush takes longer, remaining events are dropped. |

### Transport

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tls` | `bool` | `true` | Enable TLS for the gRPC connection. Set to `false` for local development (e.g. `http://localhost:4317`). |
| `api_key` | `Option<String>` | `None` | API key for authenticated collector endpoints. Sent as gRPC metadata. |

### Retries

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `max_retries` | `u32` | `3` | Maximum retry attempts for a failed batch. After this many failures, the batch is dropped and a warning is logged via `tracing`. |
| `retry_backoff` | `Duration` | `100ms` | Base backoff duration between retries. The actual backoff is `retry_backoff * attempt_number` (linear backoff). |

## Validation Rules

The builder validates configuration when `.build()` is called:

- `service` must be set (returns `Error::Config` if missing)
- `endpoint` must be set (returns `Error::Config` if missing)
- `batch_size` must be > 0
- `queue_capacity` must be >= `batch_size`

```rust
// This fails: service is required
let err = Aires::builder()
    .endpoint("http://localhost:4317")
    .build()
    .unwrap_err();
// Error::Config("service name is required")

// This fails: batch_size must be > 0
let err = Aires::builder()
    .service("test")
    .endpoint("http://localhost:4317")
    .batch_size(0)
    .build()
    .unwrap_err();
// Error::Config("batch_size must be > 0")

// This fails: queue_capacity must be >= batch_size
let err = Aires::builder()
    .service("test")
    .endpoint("http://localhost:4317")
    .batch_size(1000)
    .queue_capacity(500)
    .build()
    .unwrap_err();
// Error::Config("queue_capacity must be >= batch_size")
```

## Tuning Guidelines

### High-Throughput Applications

For services that emit millions of events per second:

```rust
let config = Aires::builder()
    .service("high-throughput-worker")
    .endpoint("http://collector:4317")
    .batch_size(1024)              // larger batches = fewer RPCs
    .batch_timeout(Duration::from_millis(200))  // ship sooner
    .queue_capacity(65536)         // large buffer for bursts
    .tls(false)                    // skip TLS in internal networks
    .build()
    .unwrap();
```

### Low-Latency Applications

For services where observability overhead must be minimal:

```rust
let config = Aires::builder()
    .service("trading-engine")
    .endpoint("http://collector:4317")
    .batch_size(64)                // smaller batches = less memory
    .batch_timeout(Duration::from_millis(1000)) // batch longer
    .queue_capacity(4096)
    .tls(false)
    .build()
    .unwrap();
```

### Development

For local development with a local collector:

```rust
let config = Aires::builder()
    .service("my-service")
    .endpoint("http://localhost:4317")
    .environment("dev")
    .tls(false)                    // no TLS locally
    .batch_size(16)                // small batches for quick feedback
    .batch_timeout(Duration::from_millis(100))
    .build()
    .unwrap();
```

## Environment Variable Pattern

The SDK doesn't read environment variables directly, but here's a common pattern:

```rust
use std::env;
use std::time::Duration;

let config = Aires::builder()
    .service(env::var("AIRES_SERVICE").unwrap_or_else(|_| "unknown".into()))
    .endpoint(env::var("AIRES_ENDPOINT").unwrap_or_else(|_| "http://localhost:4317".into()))
    .environment(env::var("AIRES_ENVIRONMENT").unwrap_or_else(|_| "dev".into()))
    .tls(env::var("AIRES_TLS").map(|v| v == "true").unwrap_or(false))
    .api_key(env::var("AIRES_API_KEY").ok().unwrap_or_default())
    .build()
    .expect("invalid aires config");
```

## Config Accessors

Once built, you can read configuration values:

```rust
let config = Aires::builder()
    .service("test")
    .endpoint("http://localhost:4317")
    .build()
    .unwrap();

println!("Service: {}", config.service());
println!("Environment: {}", config.environment());
println!("Endpoint: {}", config.endpoint());
```
