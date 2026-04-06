---
title: What is Aires?
description: An overview of the Aires observability platform — why it exists, what it does, and how it works.
---

## Overview

Aires is a high-performance observability platform that unifies logs, traces, metrics, and AI agent activity into a single structured event pipeline. It replaces expensive, fragmented observability vendors with an open, SQL-queryable system built on battle-tested infrastructure.

Every observability signal — a log line, a distributed trace span, a metric sample, an AI agent's tool invocation — is represented as a single `Event` message defined in Protobuf. Events are created by lightweight SDKs, shipped over gRPC to an Elixir collector, and stored in ClickHouse for fast analytical queries.

## Why Aires Exists

Modern observability stacks have three problems:

1. **Cost**: Datadog, Splunk, and New Relic charge per GB ingested. At scale, observability becomes the second largest infrastructure cost after compute. Aires uses ClickHouse (columnar compression, 10-30x reduction) and self-hosted infrastructure to cut costs by orders of magnitude.

2. **Fragmentation**: Logs go to one system, traces to another, metrics to a third. Correlating across signals requires proprietary query languages and fragile integrations. Aires stores everything in one table with one schema. A `trace_id` in a log event is the same `trace_id` in a span event — just a SQL `WHERE` clause.

3. **Performance tax**: Most observability SDKs add measurable latency to hot paths. They serialize to JSON, buffer in managed-language data structures, and ship over HTTP. Aires SDKs are built on a Rust core — event creation is sub-microsecond, batching is lock-free, and transport is gRPC with Protobuf encoding.

## Key Features

### Unified Event Model

Every observability signal is an `Event`. The Protobuf schema includes fields for:

- **Logging**: `severity`, `message`, `display_text`, `source_file`, `source_line`
- **Tracing**: `trace_id`, `span_id`, `parent_span_id`, `subtrace_id`
- **Metrics**: `metric.name`, `metric.value`, `metric.unit`, `metric.type`
- **HTTP**: `http.method`, `http.path`, `http.status_code`, `http.duration_ms`
- **Errors**: `error.type`, `error.message`, `error.stack`, `error.handled`
- **AI Agents**: `agent_id`, `session_id`, along with structured `data` for tool calls and LLM interactions

No more mapping between different schemas. One event, one table, one query language.

### Cross-Language SDKs

All SDKs wrap the same Rust core:

| SDK | Binding | Package |
|-----|---------|---------|
| **Rust** | Native | `aires-sdk` (crates.io) |
| **TypeScript** | NAPI-RS | `@aires/sdk` (npm) |
| **Python** | PyO3 | `aires` (pip) |

Because every SDK delegates to the Rust core, they all share identical batching behavior, retry logic, and gRPC transport. There's no behavioral divergence between languages.

### gRPC Transport

Events are Protobuf-encoded and shipped over gRPC using the `AiresCollector.Ingest` RPC. The SDK batches events in memory (default: 256 events or 500ms, whichever comes first) and sends them as an `EventBatch`. For long-lived processes, the `IngestStream` RPC uses bidirectional streaming for continuous delivery.

Benefits over HTTP+JSON:
- **~10x smaller payloads** due to Protobuf binary encoding
- **Persistent connections** — no TCP handshake per batch
- **Flow control** — gRPC's HTTP/2 framing provides built-in backpressure
- **Schema enforcement** — malformed events are rejected at the Protobuf layer

### ClickHouse Storage

Events land in a `MergeTree` table partitioned by date with bloom filter indexes on high-cardinality columns (`trace_id`, `span_id`, `session_id`). ClickHouse's columnar storage typically achieves 10-30x compression ratios on observability data.

Materialized views pre-aggregate common queries:
- `mv_error_rate` — error counts per service per minute
- `mv_http_latency` — p50/p95/p99 latency per endpoint per minute

You query with standard SQL. No proprietary query language to learn.

### OpenTelemetry Compatibility

Already instrumented with OpenTelemetry? The collector accepts OTLP over gRPC and converts OTel spans and logs to Aires events. You can migrate incrementally — keep your existing OTel instrumentation while adding Aires-native events alongside it.

### Elixir Collector

The collector is an Elixir/OTP application that provides:

- A gRPC server (`grpc-elixir`) accepting `Ingest` and `IngestStream` RPCs
- A Broadway pipeline with backpressure-aware batched inserts into ClickHouse
- Event transformation (Protobuf → flat row format)
- Observed timestamp injection
- SDK metadata tracking

The BEAM VM's preemptive scheduling ensures the collector stays responsive under load without tuning thread pools.

## What's Next

- **[Quickstart](/guides/quickstart/)** — Install the SDK, run the collector, ship your first events
- **[Architecture](/guides/architecture/)** — Understand the full data flow
- **[TypeScript SDK](/sdk/typescript/install/)** — Get started with the most common SDK
- **[Protobuf Reference](/reference/proto/)** — See the full event schema
