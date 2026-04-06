---
title: Architecture
description: How data flows through Aires — from SDK event creation to ClickHouse storage.
---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Your Application                            │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                         │
│  │  Rust    │  │TypeScript│  │  Python  │                         │
│  │  SDK     │  │  SDK     │  │  SDK     │                         │
│  │          │  │ (NAPI-RS)│  │ (PyO3)  │                         │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                         │
│       │              │              │                               │
│       │   ┌──────────┴──────────────┘                               │
│       │   │  All SDKs wrap the same                                │
│       │   │  Rust core library                                     │
│       └───┤                                                         │
│           │  Lock-free channel                                     │
│           │  ┌─────────────────┐                                   │
│           └──│  Batch Worker   │                                   │
│              │  (Tokio task)   │                                   │
│              └────────┬────────┘                                   │
│                       │ Protobuf-encoded EventBatch                │
└───────────────────────┼─────────────────────────────────────────────┘
                        │
                   gRPC │ (HTTP/2, TLS)
                        │
┌───────────────────────┼─────────────────────────────────────────────┐
│  Aires Collector      │                (Elixir/OTP)                 │
│                       ▼                                             │
│  ┌─────────────────────────────────┐                               │
│  │  gRPC Server                    │                               │
│  │  (grpc-elixir)                  │                               │
│  │  - Ingest RPC (batch)           │                               │
│  │  - IngestStream RPC (streaming) │                               │
│  └────────────────┬────────────────┘                               │
│                   │                                                 │
│                   ▼                                                 │
│  ┌─────────────────────────────────┐                               │
│  │  Transform                      │                               │
│  │  - Proto Event → flat row map   │                               │
│  │  - Timestamp normalization      │                               │
│  │  - Severity enum → string       │                               │
│  │  - Nested message flattening    │                               │
│  └────────────────┬────────────────┘                               │
│                   │                                                 │
│                   ▼                                                 │
│  ┌─────────────────────────────────┐                               │
│  │  Broadway Pipeline              │                               │
│  │  - Producer: internal queue     │                               │
│  │  - Processors: N schedulers     │                               │
│  │  - Batcher: 1000 rows / 500ms  │                               │
│  │  - Backpressure: automatic      │                               │
│  └────────────────┬────────────────┘                               │
│                   │                                                 │
│                   ▼                                                 │
│  ┌─────────────────────────────────┐                               │
│  │  ClickHouse Store (GenServer)   │                               │
│  │  - Batched INSERT statements    │                               │
│  │  - Connection pooling via Ch    │                               │
│  └────────────────┬────────────────┘                               │
│                   │                                                 │
└───────────────────┼─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ClickHouse                                                         │
│                                                                     │
│  ┌─────────────────────────────────┐                               │
│  │  events table (MergeTree)       │                               │
│  │  - Partitioned by toDate(ts)    │                               │
│  │  - Ordered by (service,         │                               │
│  │    severity, timestamp)         │                               │
│  │  - Bloom filter indexes on      │                               │
│  │    trace_id, span_id,           │                               │
│  │    session_id                   │                               │
│  │  - Token BF index on message    │                               │
│  │  - TTL: 30 days default         │                               │
│  └─────────────────────────────────┘                               │
│                                                                     │
│  ┌─────────────────────────────────┐                               │
│  │  Materialized Views             │                               │
│  │  - mv_error_rate                │                               │
│  │  - mv_http_latency             │                               │
│  └─────────────────────────────────┘                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Component Deep Dive

### SDK Layer

All Aires SDKs share the same Rust core library (`aires-sdk`). The TypeScript SDK uses NAPI-RS to compile the Rust code into a native Node addon (`.node` file). The Python SDK uses PyO3 to compile it into a native Python extension (`.so` / `.pyd`). The Rust SDK is used directly.

When you call `aires.info("message")`, the SDK:

1. **Creates an `Event`** — allocates a UUID v7 (time-ordered), captures the nanosecond timestamp, sets the severity, message, service name, and environment from config.

2. **Applies options** — any trace ID, span ID, attributes, tags, HTTP info, error info, etc. are set on the event via a builder pattern.

3. **Submits to the batch channel** — the event is sent through a `crossbeam-channel` (lock-free MPSC) to the background batch worker. This call is non-blocking and returns immediately.

4. **Batch worker collects and ships** — a dedicated Tokio task drains the channel. When `batch_size` (default: 256) events accumulate, or `batch_timeout` (default: 500ms) elapses, the worker Protobuf-encodes the batch and sends it over gRPC.

5. **Retries on failure** — if the gRPC call fails, the worker retries with exponential backoff up to `max_retries` (default: 3) times. If all retries fail, the batch is dropped and a warning is logged.

### Collector Layer

The collector is an Elixir/OTP application with four supervision children:

| Component | Module | Role |
|-----------|--------|------|
| **Store** | `AiresCollector.Store` | GenServer managing a ClickHouse connection via the `ch` library |
| **gRPC Server** | `AiresCollector.Endpoint` / `AiresCollector.Server` | Accepts `Ingest` and `IngestStream` RPCs |
| **Pipeline** | `AiresCollector.Pipeline` | Broadway pipeline for batched processing |
| **Telemetry** | `AiresCollector.Telemetry` | Exposes collector metrics (events received, inserted, failed) |

When an `EventBatch` arrives:

1. The gRPC server decodes the Protobuf message
2. Each event is transformed from the nested Proto structure to a flat map (`AiresCollector.Transform.event_to_row/3`)
3. Transformed rows are pushed into the Broadway pipeline as messages
4. Broadway's batcher groups rows (default: 1000 rows or 500ms) and calls `Store.insert_batch/1`
5. The Store issues a batched `INSERT INTO events` statement to ClickHouse

Broadway provides automatic backpressure — if ClickHouse inserts slow down, the pipeline slows the producer, which in turn applies gRPC flow control to the SDKs.

### Storage Layer

ClickHouse stores events in a `MergeTree` table with:

- **Partition key**: `toDate(timestamp)` — one partition per day, enabling efficient date-range queries and TTL-based cleanup
- **Sort order**: `(service, severity, timestamp)` — optimized for the most common query patterns (filter by service, then severity, then time range)
- **Bloom filter indexes**: on `trace_id`, `span_id`, `session_id` — enables fast point lookups on high-cardinality string columns
- **Token bloom filter**: on `message` — enables full-text-like search on log messages

Materialized views run in the background as data is inserted, maintaining pre-aggregated tables for common dashboard queries (error rates, HTTP latency percentiles).

## Data Flow Summary

```
Event Created (SDK)
  → crossbeam channel (lock-free, bounded)
    → Batch Worker (Tokio task, 256 events / 500ms)
      → Protobuf encode
        → gRPC Ingest RPC (HTTP/2, optional TLS)
          → Collector gRPC Server (Elixir)
            → Transform (Proto → flat map)
              → Broadway Pipeline (backpressure)
                → ClickHouse INSERT (batched, 1000 rows / 500ms)
                  → MergeTree storage (compressed, indexed)
                    → Materialized Views (pre-aggregated)
```

Total latency from event creation to queryable in ClickHouse is typically **< 2 seconds** under normal load, dominated by the two batching stages (SDK-side and collector-side).

## Scaling

### Horizontal Scaling

- **SDKs**: Each application instance runs its own batch worker. No coordination needed.
- **Collector**: Run multiple collector instances behind a load balancer. Each instance is stateless — it just transforms and inserts. gRPC load balancing works with standard L4/L7 balancers or Kubernetes services.
- **ClickHouse**: Use ClickHouse's native replication and sharding for write throughput beyond a single node.

### Capacity Planning

| Component | Throughput (single instance) |
|-----------|------------------------------|
| SDK batch worker | ~500K events/sec (Rust), ~200K events/sec (TS/Python due to binding overhead) |
| Collector | ~100K events/sec per Broadway pipeline (limited by ClickHouse insert speed) |
| ClickHouse | ~500K rows/sec insert (single node, depends on column count and hardware) |

For most applications, a single collector instance and a single ClickHouse node handle the load comfortably. Scale horizontally when you exceed these numbers.
