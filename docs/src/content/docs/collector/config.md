---
title: "Collector: Configuration"
description: Environment variables and tuning options for the Aires collector — gRPC port, ClickHouse connection, Broadway batching.
---

## Environment Variables

The collector is configured entirely through environment variables.

### gRPC Server

| Variable | Default | Description |
|----------|---------|-------------|
| `GRPC_PORT` | `4317` | Port for the gRPC server. The collector listens on all interfaces (`0.0.0.0`). |

### ClickHouse Connection

| Variable | Default | Description |
|----------|---------|-------------|
| `CLICKHOUSE_HOST` | `localhost` | ClickHouse server hostname or IP. |
| `CLICKHOUSE_PORT` | `8123` | ClickHouse HTTP interface port. The collector uses the HTTP protocol (not native TCP 9000). |
| `CLICKHOUSE_DATABASE` | `aires` | Database name. Must exist before the collector starts. |
| `CLICKHOUSE_USER` | `default` | ClickHouse username. |
| `CLICKHOUSE_PASSWORD` | `""` (empty) | ClickHouse password. |

### Example

```bash
# Local development
export GRPC_PORT=4317
export CLICKHOUSE_HOST=localhost
export CLICKHOUSE_PORT=8123
export CLICKHOUSE_DATABASE=aires
export CLICKHOUSE_USER=default
export CLICKHOUSE_PASSWORD=""

# Start the collector
mix run --no-halt
```

```bash
# Production (Docker)
docker run -d \
  -p 4317:4317 \
  -e GRPC_PORT=4317 \
  -e CLICKHOUSE_HOST=clickhouse.prod.internal \
  -e CLICKHOUSE_PORT=8123 \
  -e CLICKHOUSE_DATABASE=aires \
  -e CLICKHOUSE_USER=aires_writer \
  -e CLICKHOUSE_PASSWORD=secretpassword \
  ghcr.io/secondary-inc/aires-collector:latest
```

## Broadway Pipeline Tuning

The Broadway pipeline controls how events are batched before insertion into ClickHouse. The default configuration is in `AiresCollector.Pipeline`:

```elixir
batchers: [
  clickhouse: [
    concurrency: 4,
    batch_size: 1000,
    batch_timeout: 500
  ]
]
```

### Pipeline Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| **Processor concurrency** | `System.schedulers_online()` | Number of concurrent processors. Defaults to the number of CPU cores. Each processor transforms events from Proto to row format. |
| **Batcher concurrency** | `4` | Number of concurrent batcher processes. Each batcher accumulates rows and triggers ClickHouse inserts. More batchers = more parallel inserts. |
| **Batch size** | `1000` | Maximum rows per ClickHouse INSERT. When the batcher accumulates this many rows, it flushes immediately. |
| **Batch timeout** | `500` ms | Maximum time to wait before flushing a partial batch. Even if `batch_size` hasn't been reached, a flush happens after this interval. |

### Tuning for High Throughput

For collectors handling > 100K events/sec:

```elixir
# In pipeline.ex
batchers: [
  clickhouse: [
    concurrency: 8,        # more parallel inserts
    batch_size: 5000,       # larger batches = fewer INSERT statements
    batch_timeout: 200      # flush sooner under high load
  ]
]
```

Larger batch sizes are more efficient for ClickHouse (fewer INSERT statements, better compression), but increase latency before events become queryable.

### Tuning for Low Latency

For real-time dashboards where you need events queryable within seconds:

```elixir
batchers: [
  clickhouse: [
    concurrency: 4,
    batch_size: 100,        # smaller batches
    batch_timeout: 100      # flush every 100ms
  ]
]
```

Smaller batches and shorter timeouts reduce the time between event ingestion and queryability, at the cost of more frequent (and less efficient) ClickHouse inserts.

## ClickHouse Connection Pool

The `AiresCollector.Store` GenServer maintains a single connection to ClickHouse via the `ch` library. For high-throughput deployments, you may want to increase the connection pool:

The `Ch` library supports connection pooling via `db_connection`. To configure pool size, modify the Store initialization:

```elixir
# In store.ex
{:ok, conn} =
  Ch.start_link(
    hostname: System.get_env("CLICKHOUSE_HOST", "localhost"),
    port: String.to_integer(System.get_env("CLICKHOUSE_PORT", "8123")),
    database: System.get_env("CLICKHOUSE_DATABASE", "aires"),
    username: System.get_env("CLICKHOUSE_USER", "default"),
    password: System.get_env("CLICKHOUSE_PASSWORD", ""),
    pool_size: 10  # number of connections in the pool
  )
```

### Connection Pool Guidelines

| Deployment | Pool Size | Notes |
|------------|-----------|-------|
| Development | 1-2 | Default is sufficient |
| Staging | 5 | Moderate load |
| Production (single collector) | 10-20 | Match batcher concurrency |
| Production (multiple collectors) | 5-10 per instance | Avoid overwhelming ClickHouse |

## gRPC Server Configuration

The gRPC server is configured through the `GRPC.Server.Supervisor`:

```elixir
# In application.ex
{GRPC.Server.Supervisor,
 endpoint: AiresCollector.Endpoint,
 port: port(),
 start_server: true}
```

The server uses `grpc-elixir` with these defaults:
- Maximum message size: 4MB (Protobuf default)
- Keepalive: enabled
- Interceptors: `GRPC.Server.Interceptors.Logger` (logs every RPC call)

### Disabling Request Logging

In high-throughput environments, the gRPC logger interceptor can be noisy. Remove it from the endpoint:

```elixir
# In endpoint.ex
defmodule AiresCollector.Endpoint do
  use GRPC.Endpoint

  # Remove or comment out for production:
  # intercept(GRPC.Server.Interceptors.Logger)

  run(AiresCollector.Server)
end
```

## BEAM VM Tuning

For production deployments, tune the Erlang VM:

```bash
# Set in environment or release config
export ERL_AFLAGS="+P 1000000"         # max processes (default: 262144)
export ERL_AFLAGS="$ERL_AFLAGS +Q 65536"  # max ports
export ERL_AFLAGS="$ERL_AFLAGS +S 8:8"    # schedulers (match CPU cores)
export ERL_AFLAGS="$ERL_AFLAGS +sbwt very_short"  # scheduler busy-wait threshold
```

## Monitoring

The collector exposes telemetry events that can be consumed by Prometheus, StatsD, or any `:telemetry`-compatible backend:

| Event | Measurements | Metadata |
|-------|-------------|----------|
| `[:aires, :ingest, :start]` | — | `%{batch_size: n}` |
| `[:aires, :ingest, :stop]` | `%{duration: ns}` | `%{accepted: n, rejected: n}` |
| `[:aires, :insert, :start]` | — | `%{row_count: n}` |
| `[:aires, :insert, :stop]` | `%{duration: ns}` | `%{row_count: n}` |
| `[:aires, :insert, :exception]` | `%{duration: ns}` | `%{reason: term}` |

Example telemetry handler:

```elixir
:telemetry.attach("aires-logger", [:aires, :insert, :stop], fn
  _event, %{duration: duration}, %{row_count: count}, _config ->
    ms = System.convert_time_unit(duration, :native, :millisecond)
    Logger.info("inserted #{count} rows in #{ms}ms")
end, nil)
```
