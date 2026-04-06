<p align="center">
  <h1 align="center">Aires</h1>
  <p align="center">High-performance observability for modern applications.</p>
</p>

<p align="center">
  <a href="https://aires.secondary.sh">Documentation</a> &middot;
  <a href="https://aires.secondary.sh/guides/quickstart">Quick Start</a> &middot;
  <a href="https://aires.secondary.sh/guides/architecture">Architecture</a>
</p>

---

Aires is an observability platform built for speed, cost-efficiency, and developer experience. It collects structured events from your applications via a Rust-core SDK, ships them over gRPC to an Elixir collector, and stores them in ClickHouse for blazing-fast queries.

## Why Aires

- **1000x cheaper than Datadog** — ClickHouse storage costs pennies per GB. No per-host, per-container, or per-metric pricing.
- **Rust-core SDK** — Event creation and serialization happen in native code via arena-allocated buffers. Zero global allocator contention on the hot path.
- **Language bindings** — TypeScript (NAPI-RS), Python (PyO3), with more coming. Same Rust performance underneath.
- **Elixir collector** — BEAM VM handles millions of concurrent connections. Broadway pipelines batch inserts to ClickHouse efficiently.
- **ClickHouse storage** — Column-oriented, partitioned by date, bloom filter indexes on trace/session/user IDs, materialized views for dashboards.
- **OpenTelemetry compatible** — Ingest OTLP alongside native Aires events.

## Quick Start

### TypeScript

```bash
npm install @aires/sdk
```

```typescript
import { log, aires } from "@aires/sdk"

aires.init({ service: "my-api", endpoint: "collector:4317" })

log("server started")
log.warn("disk almost full")
log.error("request failed", { path: "/api/users", status: "500" })

const traced = log.with({ traceId: "abc-123", userId: "user-1" })
traced("processing order")

const span = log.span("db-query")
// ... do work ...
span.end()

log.metric("http.latency_ms", 42, { method: "POST" })
```

### Python

```bash
pip install aires
```

```python
from aires import log, aires

aires.init(service="my-api", endpoint="collector:4317")

log("server started")
log.warn("disk almost full")
log.error("request failed", path="/api/users", status=500)

traced = log.with_(trace_id="abc-123", user_id="user-1")
traced("processing order")

with log.span("db-query", table="users") as span:
    # ... do work ...
    span.log("query complete", rows=42)

log.metric("http.latency_ms", 42, method="POST")
```

### Rust

```toml
[dependencies]
aires-sdk = "0.1"
```

```rust
use aires_sdk::Aires;

let aires = Aires::builder()
    .service("my-api")
    .endpoint("http://collector:4317")
    .build()?;

aires.info("server started").attr("port", "4000").emit();
aires.warn("high latency").attr("p99_ms", "1200").emit();

let span = aires.span("db-query").attr("table", "users");
// ... do work ...
span.emit();
```

## Architecture

```
┌─────────────┐     gRPC      ┌──────────────┐   batch    ┌────────────┐
│  Your App   │ ──────────────▸│   Collector   │ ─────────▸│ ClickHouse │
│  (SDK)      │                │   (Elixir)    │           │            │
└─────────────┘                └──────────────┘           └────────────┘
  Rust core                     Broadway pipeline          MergeTree
  arena-alloc                   back-pressure              bloom indexes
  batch+retry                   OTel compat                mat. views
```

Events flow through three stages:

1. **SDK** — Creates structured events, serializes via arena-allocated buffers, ships in batches over gRPC with retry and backpressure.
2. **Collector** — Elixir/OTP application accepting gRPC streams. Broadway pipeline batches events and inserts into ClickHouse.
3. **ClickHouse** — Column-oriented storage partitioned by date. Bloom filter indexes on high-cardinality fields. Materialized views for error rates and latency percentiles.

## Packages

| Package | Language | Description |
|---------|----------|-------------|
| `packages/sdk-rust` | Rust | Core SDK — event creation, batching, gRPC shipping, arena allocation |
| `packages/sdk-ts` | TypeScript | NAPI-RS bindings + `log()` DX, Elysia plugin, console patching |
| `packages/sdk-python` | Python | PyO3 bindings + Logger class, span context manager, logging patch |
| `packages/collector` | Elixir | gRPC server + Broadway pipeline + ClickHouse batch inserts |
| `packages/store` | SQL | ClickHouse schema, indexes, materialized views |

## Documentation

Full documentation lives at [aires.secondary.sh](https://aires.secondary.sh), built with Astro Starlight.

## License

MIT
