---
title: "Rust SDK: Installation"
description: Add the Aires Rust SDK to your project with Cargo.
---

## Installation

Add `aires-sdk` to your `Cargo.toml`:

```toml
[dependencies]
aires-sdk = "0.1"
```

Or from the workspace path (in the Aires monorepo):

```toml
[dependencies]
aires-sdk = { path = "../sdk-rust" }
```

## Build Requirements

The Rust SDK uses `tonic` for gRPC and `prost` for Protobuf. The build step compiles the `.proto` file into Rust types using `tonic-build`, which requires:

- **Rust 1.75+** (for `async fn` in traits)
- **`protoc`** — the Protobuf compiler must be in your `PATH`

Install `protoc`:

```bash
# macOS
brew install protobuf

# Ubuntu/Debian
apt install -y protobuf-compiler

# Arch
pacman -S protobuf
```

## Dependencies

The SDK depends on:

| Crate | Purpose |
|-------|---------|
| `tonic` | gRPC client (HTTP/2 transport) |
| `prost` | Protobuf code generation and serialization |
| `tokio` | Async runtime for the batch worker |
| `uuid` | UUID v7 generation for event IDs |
| `crossbeam-channel` | Lock-free MPSC channel for batching |
| `serde` / `serde_json` | Serialization for the `data` field |
| `parking_lot` | Fast synchronization primitives |
| `tracing` | Internal diagnostic logging |
| `thiserror` | Error type derivation |
| `bytes` | Byte buffer handling |
| `rmp-serde` | MessagePack serialization (for compact data encoding) |

All dependencies are workspace-managed in the Aires monorepo.

## Feature Flags

The SDK currently has no optional feature flags. All functionality is included by default. Future releases may add:

- `tls` — TLS support for gRPC (currently always compiled)
- `compression` — gzip/zstd compression for gRPC payloads
- `otel-bridge` — bridge to OpenTelemetry's tracing API

## Verify Installation

```rust
use aires_sdk::Aires;

fn main() {
    let _aires = Aires::builder()
        .service("test")
        .endpoint("http://localhost:4317")
        .build()
        .expect("failed to build config");

    println!("aires-sdk installed successfully");
}
```

```bash
cargo run
```

## Next Steps

- **[Usage](/sdk/rust/usage/)** — Builder pattern, logging, spans, metrics
- **[Configuration](/sdk/rust/config/)** — All configuration options
