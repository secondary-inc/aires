---
title: Benchmarks
description: Performance comparison — Aires vs Pino vs Winston
---

Aires is designed for high-throughput observability with minimal overhead. Here are real benchmark results comparing Aires against the two most popular Node.js logging libraries.

## Environment

- **Hardware**: Apple M4 Max
- **Runtime**: Bun 1.2.x
- **Rust**: 1.94.1 (edition 2024)
- **Methodology**: All JS benchmarks write to `/dev/null` to isolate serialization cost from disk I/O. 100K iterations with 10K warmup. Rust benchmarks use Criterion with statistical analysis.

## TypeScript: Aires vs Pino vs Winston

### Simple message

```
log.info("hello world")
```

| Library | ns/op | ops/sec | vs fastest |
|---------|------:|--------:|-----------|
| **aires (js)** | **536** | **1.86M** | baseline |
| winston | 974 | 1.03M | 1.8x slower |
| pino | 1,094 | 914K | 2.0x slower |

### Message + 3 attributes

```
log.info("request completed", { userId: "user-abc", traceId: "trace-123", path: "/api/agents" })
```

| Library | ns/op | ops/sec | vs fastest |
|---------|------:|--------:|-----------|
| **aires (js)** | **753** | **1.33M** | baseline |
| pino | 1,578 | 634K | 2.1x slower |
| winston | 2,521 | 397K | 3.3x slower |

### Message + 8 attributes (HTTP request log)

```
log.info("request completed", {
  userId: "user-abc", traceId: "trace-123", sessionId: "sess-xyz",
  method: "POST", path: "/agents/list", status: "200",
  durationMs: "42", requestSize: "256"
})
```

| Library | ns/op | ops/sec | vs fastest |
|---------|------:|--------:|-----------|
| **aires (js)** | **647** | **1.54M** | baseline |
| pino | 1,654 | 605K | 2.6x slower |
| winston | 2,546 | 393K | 3.9x slower |

### Scoped logger (child/with)

```
const child = log.with({ userId: "user-abc", sessionId: "sess-xyz" })
child.info("request", { path: "/api" })
```

| Library | ns/op | ops/sec | vs fastest |
|---------|------:|--------:|-----------|
| **aires (js)** | **596** | **1.68M** | baseline |
| pino child | 1,315 | 760K | 2.2x slower |
| winston child | 1,394 | 717K | 2.3x slower |

### Error with stack trace

```
log.error("unhandled error", { err, traceId: "t-1" })
```

| Library | ns/op | ops/sec | vs fastest |
|---------|------:|--------:|-----------|
| **aires (js)** | **1,731** | **578K** | baseline |
| pino | 2,237 | 447K | 1.3x slower |
| winston | 3,633 | 275K | 2.1x slower |

:::note
The "aires (js)" numbers are the **pure JavaScript fallback** — no native addon compiled. This is the slow path. With the NAPI-RS native addon (Rust core), event serialization drops to ~62 ns per event, an additional 10x speedup.
:::

## Rust: Serialization Microbenchmarks

These measure the Rust core directly, via Criterion with statistical analysis.

| Operation | Time | Throughput |
|-----------|-----:|-----------|
| Event creation | 212 ns | 4.7M events/sec |
| JSON serialize (single event) | 200 ns | 5.0M events/sec |
| **Proto encode (single event)** | **62 ns** | **16.1M events/sec** |
| Proto encode (256 batch, heap) | 17.4 us | 14.7M events/sec |
| Proto encode (256 batch, arena) | 42.9 us | 5.9M events/sec |
| Batch build (256 events) | 46.6 us | 5.5M batches/sec |

Proto encoding is **3.2x faster than JSON** for the same event payload. This is why Aires uses protobuf over gRPC rather than JSON over HTTP.

Arena allocation (`arena-alligator`) adds overhead for small batches due to setup cost, but provides **lock-free concurrent allocation** — critical under high thread contention where the global heap allocator becomes the bottleneck.

## End-to-End Comparison

| Path | Per-event cost | Events/sec | vs pino |
|------|---------------|-----------|---------|
| winston (JSON to fd) | ~2,500 ns | 400K | 0.6x |
| pino (JSON to fd) | ~1,500 ns | 670K | 1.0x |
| aires JS fallback (JSON to fd) | ~650 ns | 1.5M | 2.3x |
| **aires native (proto to channel)** | **~62 ns** | **16M** | **25x** |

## Reproducing

### TypeScript benchmarks

```bash
cd benchmarks
bun install
bun run bench
```

### Rust benchmarks

```bash
cargo bench -p aires-sdk
```

Criterion HTML reports are generated in `target/criterion/`.

### Full script

The TypeScript benchmark source is at [`benchmarks/bench.ts`](https://github.com/secondary-inc/aires/blob/main/benchmarks/bench.ts). It measures:

1. **Simple message** — `log("hello world")`
2. **3 attributes** — message + userId, traceId, path
3. **8 attributes** — full HTTP request log
4. **Scoped logger** — pino child, winston child, aires `.with()`
5. **Error + stack** — error object with stack trace serialization

Each workload runs 100K iterations after a 10K warmup. Timing uses `Bun.nanoseconds()` for sub-microsecond precision. All loggers write to `/dev/null` to eliminate I/O variance.

The Rust benchmarks are at [`packages/sdk-rust/benches/ingest.rs`](https://github.com/secondary-inc/aires/blob/main/packages/sdk-rust/benches/ingest.rs), using Criterion for statistical rigor (100 samples per benchmark, outlier detection, confidence intervals).
