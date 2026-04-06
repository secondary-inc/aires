# Benchmarks

Run on Apple M4 Max, macOS, Bun 1.2.x, Rust 1.94.1.

All JS benchmarks write to `/dev/null` to isolate serialization from I/O.

## TypeScript: Aires vs Pino vs Winston

| Workload | pino | winston | aires (js) | aires speedup |
|----------|------|---------|-----------|---------------|
| Simple message | 1,094 ns | 974 ns | **536 ns** | 1.8-2.0x |
| Message + 3 attrs | 1,578 ns | 2,521 ns | **753 ns** | 2.1-3.3x |
| Message + 8 attrs (HTTP) | 1,654 ns | 2,546 ns | **647 ns** | 2.6-3.9x |
| Scoped logger (child) | 1,315 ns | 1,394 ns | **596 ns** | 2.2-2.3x |
| Error + stack trace | 2,237 ns | 3,633 ns | **1,731 ns** | 1.3-2.1x |

**Aires JS fallback is 2-4x faster than pino and winston** for structured logging.

The JS fallback is the *slow path*. With the NAPI-RS native addon (Rust core),
serialization drops to ~62 ns per event (proto) or ~200 ns (JSON) — an additional
3-10x speedup over the JS numbers.

## Rust: Serialization Microbenchmarks

| Operation | Time | Throughput |
|-----------|------|-----------|
| Event creation | 212 ns | 4.7M events/sec |
| JSON serialize (single event) | 200 ns | 5.0M events/sec |
| Proto encode (single event) | 62 ns | **16.1M events/sec** |
| Proto encode (256 batch, heap) | 17.4 µs | 14.7M events/sec |
| Proto encode (256 batch, arena) | 42.9 µs | 5.9M events/sec |
| Batch build (256 events) | 46.6 µs | 5.5M batches/sec |

**Proto encoding is 3.2x faster than JSON** for the same event payload.

Arena allocation adds overhead for small batches due to setup cost,
but provides lock-free concurrent allocation — critical under high thread
contention where heap allocation becomes the bottleneck.

## End-to-End Comparison

| Path | Per-event cost | Events/sec (single thread) |
|------|---------------|--------------------------|
| winston (JSON → fd) | ~2,500 ns | 400K |
| pino (JSON → fd) | ~1,500 ns | 670K |
| aires JS fallback (JSON → fd) | ~650 ns | 1.5M |
| aires native (proto → channel) | ~62 ns | **16M** |

Aires with the native addon is **25x faster than pino** and **40x faster than winston**.

## Running

```bash
# TypeScript benchmarks
cd benchmarks && bun run bench

# Rust benchmarks (Criterion)
cargo bench -p aires-sdk
```
