---
title: "TypeScript SDK: Installation"
description: Install and initialize the Aires TypeScript SDK in Bun or Node.js projects.
---

## Installation

```bash
bun add @aires/sdk
```

Or with npm/pnpm/yarn:

```bash
npm install @aires/sdk
pnpm add @aires/sdk
yarn add @aires/sdk
```

The package name is `@aires/sdk`. It ships as a TypeScript source module (`"main": "./src/index.ts"`) and includes a prebuilt native addon for supported platforms.

## Initialization

Initialize the SDK once at application startup, before logging any events:

```typescript
import { aires } from "@aires/sdk"

aires.init({
  service: "my-api",
  endpoint: "http://localhost:4317",
  environment: "production",
})
```

### `InitOptions`

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `service` | `string` | Yes | — | Service name (e.g. `"workforce-api"`, `"billing-worker"`) |
| `endpoint` | `string` | Yes | — | Collector gRPC endpoint (e.g. `"http://localhost:4317"`, `"https://collector.prod:4317"`) |
| `environment` | `string` | No | `"production"` | Environment name (`"production"`, `"staging"`, `"dev"`) |
| `batchSize` | `number` | No | `256` | Events per batch before flushing |
| `queueCapacity` | `number` | No | `8192` | Maximum events buffered in memory |
| `tls` | `boolean` | No | `true` | Enable TLS for the gRPC connection |
| `apiKey` | `string` | No | — | API key for authenticated endpoints |

### Bun Compatibility

The SDK is designed for Bun as the primary runtime. The native addon is compiled via NAPI-RS and loaded as a `.node` file using `require()`. Bun supports NAPI addons natively.

```typescript
// This works in Bun out of the box
import { aires } from "@aires/sdk"
```

No additional configuration is needed for Bun.

### Node.js Compatibility

The SDK also works in Node.js 18+. Ensure your project supports CommonJS `require()` calls (the native addon is loaded via `require()`):

```typescript
// Works in Node.js 18+ with ESM or CommonJS
import { aires } from "@aires/sdk"
```

If you're using a bundler that doesn't handle native addons (e.g. esbuild, Vite), you'll need to mark `@aires/sdk` as external:

```javascript
// esbuild
{
  external: ["@aires/sdk"]
}
```

### Native Addon vs. Fallback

The SDK ships with a native addon compiled from Rust via NAPI-RS. This is the high-performance path — events are serialized to Protobuf in native code and shipped over gRPC using Tonic.

If the native addon can't be loaded (e.g. unsupported platform, missing binary), the SDK falls back to a pure JavaScript mode that buffers events in memory and dumps them as JSON to stdout on flush. This fallback is intended for development and debugging only — it does not ship events to the collector.

```typescript
// The SDK automatically detects whether the native addon is available.
// No configuration needed — it falls back transparently.
aires.init({
  service: "my-api",
  endpoint: "http://localhost:4317",
})

// In fallback mode, this buffers in memory:
aires.info("hello from fallback mode")

// In fallback mode, this dumps JSON to stdout:
await aires.flush()
```

To verify that the native addon is loaded, check the logs at startup. The native addon initialization will throw if the binary is missing, and the SDK catches this silently.

### Building the Native Addon

If you need to build the native addon from source (e.g. for an unsupported platform):

```bash
# From the sdk-ts package directory
cd native
cargo build --release
```

This requires:
- Rust toolchain (1.75+)
- Protobuf compiler (`protoc`)
- NAPI-RS CLI (`npm install -g @napi-rs/cli`)

The built addon will be at `native/target/release/aires-sdk-napi.node`.

## Flushing

Always flush before your process exits to ensure all buffered events are shipped:

```typescript
// At process shutdown
await aires.flush()
```

For HTTP servers, flush on `SIGTERM`:

```typescript
process.on("SIGTERM", async () => {
  await aires.flush()
  process.exit(0)
})
```

For Bun:

```typescript
process.on("beforeExit", async () => {
  await aires.flush()
})
```

## Next Steps

- **[Logging](/sdk/typescript/logging/)** — All logging patterns and severity levels
- **[Tracing](/sdk/typescript/tracing/)** — Distributed trace propagation
- **[Metrics](/sdk/typescript/metrics/)** — Recording metric values
- **[HTTP Middleware](/sdk/typescript/http/)** — Automatic HTTP instrumentation
