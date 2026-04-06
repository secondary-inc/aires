---
title: "Rust SDK: Usage"
description: Using the Aires Rust SDK — builder pattern, log levels, event builder fluent API, spans, metrics, and macros.
---

## Initialization

Create an `Aires` instance using the builder pattern:

```rust
use aires_sdk::Aires;

#[tokio::main]
async fn main() {
    let aires = Aires::builder()
        .service("my-service")
        .endpoint("http://localhost:4317")
        .environment("production")
        .build()
        .expect("failed to build config");

    let aires = Aires::from_config(aires).expect("failed to create client");

    // Use aires...

    aires.flush().await;
}
```

The `Aires` instance owns a background Tokio task that batches and ships events. It must live for the duration of your application. When dropped, it flushes remaining events synchronously.

## Log Levels

Six severity levels are available, each returning an `EventBuilder`:

```rust
aires.trace("entering inner loop");
aires.debug("parsed 42 config entries");
aires.info("server listening on :3000");
aires.warn("connection pool utilization at 85%");
aires.error("handler returned 500");
aires.fatal("database unreachable, shutting down");
```

Each method returns an `EventBuilder` — you must call `.emit()` to send the event:

```rust
// This does nothing (builder not emitted):
aires.info("forgotten event");

// This sends the event:
aires.info("server started").emit();
```

## EventBuilder Fluent API

The `EventBuilder` provides a fluent API for attaching context to events. Every method returns `Self`, so you can chain calls:

```rust
aires.info("order processed")
    .trace_id("trace-abc-123")
    .span_id("span-001")
    .session_id("sess-789")
    .user_id("user-42")
    .agent_id("billing-agent")
    .category("payment")
    .kind("request")
    .display_text("\x1b[32m✓\x1b[0m Order processed successfully")
    .tag("stripe")
    .tag("production")
    .attr("order_id", "ord-456")
    .attr("amount", "14999")
    .attr("currency", "usd")
    .data("order_details", &order)  // anything implementing Serialize
    .related("customer", "cust-789", "Acme Corp")
    .source(file!(), line!() as i32, "process_order")
    .emit();
```

### Builder Methods Reference

| Method | Signature | Description |
|--------|-----------|-------------|
| `trace_id` | `(impl Into<String>) -> Self` | Set distributed trace ID |
| `span_id` | `(impl Into<String>) -> Self` | Set span ID |
| `parent_span_id` | `(impl Into<String>) -> Self` | Set parent span ID |
| `subtrace_id` | `(impl Into<String>) -> Self` | Set subtrace ID |
| `session_id` | `(impl Into<String>) -> Self` | Set session ID |
| `user_id` | `(impl Into<String>) -> Self` | Set user ID |
| `agent_id` | `(impl Into<String>) -> Self` | Set AI agent ID |
| `category` | `(impl Into<String>) -> Self` | Set event category (e.g. `"http"`, `"db"`) |
| `kind` | `(impl Into<String>) -> Self` | Set event kind (e.g. `"request"`, `"metric"`) |
| `display_text` | `(impl Into<String>) -> Self` | Set formatted display text |
| `tag` | `(impl Into<String>) -> Self` | Add a tag (call multiple times for multiple tags) |
| `attr` | `(impl Into<String>, impl Into<String>) -> Self` | Add a string attribute |
| `data` | `(impl Into<String>, impl Serialize) -> Self` | Add a structured data field (JSON-serialized) |
| `related` | `(impl Into<String>, impl Into<String>, impl Into<String>) -> Self` | Add a related object (type, id, label) |
| `source` | `(&str, i32, &str) -> Self` | Set source file, line, function |
| `http` | `(impl Into<String>, impl Into<String>, i32, i64) -> Self` | Set HTTP info (method, path, status, duration_ms) |
| `error_info` | `(impl Into<String>, impl Into<String>, impl Into<String>, bool) -> Self` | Set error info (type, message, stack, handled) |
| `duration_ns` | `(u64) -> Self` | Set span duration in nanoseconds |
| `emit` | `(self)` | Send the event to the batch worker |

## Spans

Create a span to represent a unit of work within a trace:

```rust
use uuid::Uuid;

let trace_id = Uuid::now_v7().to_string();
let span_id = Uuid::now_v7().to_string();

aires.span("process-task")
    .trace_id(&trace_id)
    .span_id(&span_id)
    .category("task")
    .attr("task_id", "task-123")
    .emit();

// Child span
let child_span_id = Uuid::now_v7().to_string();
aires.span("query-database")
    .trace_id(&trace_id)
    .span_id(&child_span_id)
    .parent_span_id(&span_id)
    .category("db")
    .attr("db.operation", "SELECT")
    .attr("db.table", "tasks")
    .emit();
```

## Metrics

Record metric values:

```rust
// Gauge
aires.metric("db.connections.active", 42.0)
    .attr("pool", "primary")
    .emit();

// Counter (increment by 1)
aires.metric("http.requests.total", 1.0)
    .attr("method", "POST")
    .attr("path", "/api/tasks")
    .attr("status", "201")
    .emit();

// Histogram observation (latency)
aires.metric("http.request.duration_ms", 47.2)
    .attr("method", "POST")
    .attr("path", "/api/tasks")
    .tag("api")
    .emit();
```

## HTTP Events

Use the `.http()` builder method for HTTP request/response events:

```rust
aires.info("POST /api/tasks")
    .trace_id(&trace_id)
    .span_id(&span_id)
    .category("http")
    .http("POST", "/api/tasks", 201, 47)
    .attr("user_agent", "curl/8.0")
    .emit();
```

## Error Events

Attach error information with `.error_info()`:

```rust
match db.execute(&query).await {
    Ok(_) => {},
    Err(e) => {
        aires.error("database query failed")
            .trace_id(&trace_id)
            .category("db")
            .error_info(
                "PostgresError",             // error type
                &e.to_string(),              // message
                &format!("{:?}", e),         // stack/debug repr
                true,                        // handled
            )
            .attr("query", &query)
            .emit();
    }
}
```

## The `aires_log!` Macro

The `aires_log!` macro automatically captures source location:

```rust
use aires_sdk::aires_log;

// Basic usage
aires_log!(aires, info, "server started");

// With attributes
aires_log!(aires, error, "request failed",
    method = "POST",
    path = "/api/tasks",
    status = "500"
);
```

This expands to:

```rust
aires.info("request failed")
    .source(file!(), line!() as i32, "")
    .attr("method", "POST")
    .attr("path", "/api/tasks")
    .attr("status", "500")
    .emit();
```

## Flushing

Always flush before shutdown to ensure all buffered events are shipped:

```rust
// Async flush (preferred)
aires.flush().await;

// The Drop impl calls flush_sync() automatically,
// but explicit flushing gives you error handling.
```

For graceful shutdown:

```rust
use tokio::signal;

#[tokio::main]
async fn main() {
    let aires = /* ... */;

    // ... application logic ...

    // Wait for SIGTERM
    signal::ctrl_c().await.expect("failed to listen for ctrl-c");

    // Flush all remaining events
    aires.flush().await;
}
```

## Thread Safety

`Aires` is `Send + Sync` and can be shared across threads. The recommended pattern is to wrap it in an `Arc` or use a `static OnceLock`:

```rust
use std::sync::OnceLock;
use aires_sdk::Aires;

static AIRES: OnceLock<Aires> = OnceLock::new();

fn init() {
    let config = Aires::builder()
        .service("my-service")
        .endpoint("http://localhost:4317")
        .build()
        .unwrap();

    AIRES.set(Aires::from_config(config).unwrap()).unwrap();
}

fn get() -> &'static Aires {
    AIRES.get().expect("aires not initialized")
}
```
