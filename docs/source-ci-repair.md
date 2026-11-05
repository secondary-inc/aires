---
title: Source CI dependency and formatting repair
---

The November 4 repair updates the existing vulnerable Rust dependency paths without adding advisory exceptions. PyO3 and its build helper move together to 0.29, with the lock selecting 0.29.3. The targeted lock update selects crossbeam-epoch 0.9.21, h2 0.4.20, rustls 0.23.46 and rustls-webpki 0.103.16. The current RustSec scan additionally identified RUSTSEC-2026-0386 in Tokio 1.51.0; the targeted follow-up selects Tokio 1.54.1. Cargo also reconciles existing compatible socket2 and windows-sys references without adding packages. Native Linux ARM64 clippy and workspace tests passed again after that update.

Native Linux ARM64 Rust 1.92 clippy with warnings denied and workspace tests passed against the repaired lock. Elixir 1.17.3 formatting now passes for the collector, including the metrics route and numeric conversion helpers. Rust ClickHouse cases retain their existing unavailable-service skip; this run did not verify live ClickHouse behavior or Python extension runtime behavior.

The isolated AMD64 CI image acceptance, current advisory scan and repository admission enrollment are still pending. No deployment or independent approval is implied by these source checks.
