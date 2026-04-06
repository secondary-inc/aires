---
title: "Python SDK: Installation"
description: Install the Aires Python SDK — pip install, building from source with maturin, and virtual environment setup.
---

## Installation

### From PyPI

```bash
pip install aires
```

The package ships as a prebuilt wheel for common platforms (Linux x86_64, macOS arm64/x86_64). The wheel contains a native extension compiled from Rust via PyO3 — no Rust toolchain is needed for installation.

### In a Virtual Environment

```bash
python -m venv .venv
source .venv/bin/activate  # Linux/macOS
# .venv\Scripts\activate   # Windows

pip install aires
```

### With Poetry

```bash
poetry add aires
```

### With uv

```bash
uv add aires
```

## Building from Source

If no prebuilt wheel is available for your platform, or you want to build from the monorepo source:

### Prerequisites

- Python 3.9+
- Rust 1.75+ (`rustup` recommended)
- `protoc` (Protobuf compiler)
- `maturin` (Python-Rust build tool)

### Install maturin

```bash
pip install maturin
```

### Build and install

From the `packages/sdk-python` directory:

```bash
# Development build (faster, unoptimized)
maturin develop

# Release build (optimized)
maturin develop --release

# Build a wheel for distribution
maturin build --release
```

The `maturin develop` command compiles the Rust code and installs the resulting native extension into your active Python environment.

### Project Structure

```
packages/sdk-python/
├── Cargo.toml          # Rust crate config (PyO3 dependency)
├── pyproject.toml      # Python package config
└── src/
    └── lib.rs          # PyO3 bindings wrapping aires-sdk
```

The Python SDK is a thin binding layer. The `lib.rs` file:

1. Imports `aires_sdk::Aires` (the Rust core)
2. Exposes `init()`, `trace()`, `debug()`, `info()`, `warn()`, `error()`, `fatal()`, and `metric()` as Python functions
3. Uses a `static OnceLock<Aires>` for the global instance

## Verify Installation

```python
import aires

aires.init("my-service", "http://localhost:4317")
aires.info("hello from python")
print("aires installed successfully")
```

## Platform Support

| Platform | Architecture | Status |
|----------|-------------|--------|
| Linux | x86_64 | Prebuilt wheel |
| Linux | aarch64 | Prebuilt wheel |
| macOS | arm64 (Apple Silicon) | Prebuilt wheel |
| macOS | x86_64 (Intel) | Prebuilt wheel |
| Windows | x86_64 | Build from source |

## Next Steps

- **[Usage](/sdk/python/usage/)** — Logging, metrics, and all SDK functions
