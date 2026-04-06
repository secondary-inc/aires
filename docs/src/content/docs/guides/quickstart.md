---
title: Quickstart
description: Ship your first events to Aires in 5 minutes — install the SDK, start the collector, and query your data.
---

This guide gets you from zero to querying structured events in ClickHouse in under 5 minutes using the TypeScript SDK and Docker Compose.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [Bun](https://bun.sh) (or Node.js 18+)

## 1. Start the Infrastructure

Create a `docker-compose.yml` that runs the Aires collector and ClickHouse:

```yaml
# docker-compose.yml
services:
  clickhouse:
    image: clickhouse/clickhouse-server:24.8
    ports:
      - "8123:8123"   # HTTP interface
      - "9000:9000"   # Native protocol
    volumes:
      - clickhouse_data:/var/lib/clickhouse
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    environment:
      CLICKHOUSE_DB: aires
      CLICKHOUSE_USER: default
      CLICKHOUSE_PASSWORD: ""

  collector:
    image: ghcr.io/secondary-inc/aires-collector:latest
    ports:
      - "4317:4317"   # gRPC
    environment:
      GRPC_PORT: "4317"
      CLICKHOUSE_HOST: clickhouse
      CLICKHOUSE_PORT: "8123"
      CLICKHOUSE_DATABASE: aires
      CLICKHOUSE_USER: default
      CLICKHOUSE_PASSWORD: ""
    depends_on:
      - clickhouse

volumes:
  clickhouse_data:
```

Create the ClickHouse schema in `init.sql`:

```sql
-- init.sql
CREATE DATABASE IF NOT EXISTS aires;

CREATE TABLE IF NOT EXISTS aires.events
(
    id               String,
    timestamp        DateTime64(9, 'UTC'),
    service          LowCardinality(String),
    environment      LowCardinality(String),
    host             String,
    instance         String,
    severity         LowCardinality(String),
    message          String,
    display_text     String,
    body             String,
    trace_id         String,
    span_id          String,
    parent_span_id   String,
    subtrace_id      String,
    session_id       String,
    user_id          String,
    agent_id         String,
    source_file      String,
    source_line      UInt32,
    source_function  String,
    category         LowCardinality(String),
    kind             LowCardinality(String),
    tags             Array(String),
    http_method      LowCardinality(String),
    http_path        String,
    http_status_code UInt16,
    http_duration_ms Int64,
    metric_name      LowCardinality(String),
    metric_value     Float64,
    error_type       LowCardinality(String),
    error_message    String,
    error_stack      String,
    error_handled    Bool,
    sdk_name         LowCardinality(String),
    sdk_version      LowCardinality(String),
    sdk_language     LowCardinality(String),

    INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_id span_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_session_id session_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_message message TYPE tokenbf_v1(10240, 3, 0) GRANULARITY 1
)
ENGINE = MergeTree()
PARTITION BY toDate(timestamp)
ORDER BY (service, severity, timestamp)
TTL toDateTime(timestamp) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;
```

Start the stack:

```bash
docker compose up -d
```

## 2. Install the SDK

```bash
bun add @aires/sdk
```

Or with npm:

```bash
npm install @aires/sdk
```

## 3. Ship Events

Create a file `demo.ts`:

```typescript
import { aires } from "@aires/sdk"

// Initialize — connects to the collector over gRPC
aires.init({
  service: "quickstart-demo",
  endpoint: "http://localhost:4317",
  environment: "dev",
})

// Log events at different severity levels
aires.info("application started", {
  attr: { version: "1.0.0", runtime: "bun" },
  tags: ["startup"],
})

aires.debug("loading configuration", {
  attr: { configPath: "/etc/app/config.toml" },
})

// Simulate an HTTP request
aires.info("POST /api/tasks", {
  category: "http",
  traceId: "trace-abc-123",
  spanId: "span-001",
  http: {
    method: "POST",
    path: "/api/tasks",
    status: 201,
    durationMs: 47,
  },
  attr: { userId: "user-42" },
})

// Log an error with full context
aires.error("database connection timeout", {
  category: "db",
  traceId: "trace-abc-123",
  spanId: "span-002",
  error: {
    type: "ConnectionError",
    message: "timeout after 5000ms",
    stack: "ConnectionError: timeout after 5000ms\n    at Pool.connect (pool.ts:42)",
    handled: true,
  },
  tags: ["postgres", "timeout"],
})

// Record a metric
aires.metric("http.request.duration", 47.2, {
  tags: ["api", "tasks"],
  attr: { method: "POST", path: "/api/tasks" },
})

// Flush to ensure all events are shipped before exit
await aires.flush()

console.log("Events shipped successfully.")
```

Run it:

```bash
bun run demo.ts
```

## 4. Query Your Data

Open the ClickHouse HTTP interface or use `clickhouse-client`:

```bash
docker exec -it $(docker compose ps -q clickhouse) clickhouse-client
```

### See all events

```sql
SELECT
    timestamp,
    severity,
    service,
    message,
    category,
    trace_id
FROM aires.events
ORDER BY timestamp DESC
LIMIT 20;
```

### Find errors

```sql
SELECT
    timestamp,
    message,
    error_type,
    error_message,
    trace_id
FROM aires.events
WHERE severity = 'error'
ORDER BY timestamp DESC;
```

### Trace a request

```sql
SELECT
    timestamp,
    severity,
    message,
    span_id,
    category
FROM aires.events
WHERE trace_id = 'trace-abc-123'
ORDER BY timestamp;
```

### HTTP latency percentiles

```sql
SELECT
    http_path,
    count() AS requests,
    quantile(0.5)(http_duration_ms) AS p50,
    quantile(0.95)(http_duration_ms) AS p95,
    quantile(0.99)(http_duration_ms) AS p99
FROM aires.events
WHERE category = 'http'
  AND http_path != ''
GROUP BY http_path
ORDER BY requests DESC;
```

## 5. Next Steps

- **[Architecture](/guides/architecture/)** — Understand how data flows through the system
- **[TypeScript SDK: Logging](/sdk/typescript/logging/)** — All logging patterns and options
- **[TypeScript SDK: Tracing](/sdk/typescript/tracing/)** — Distributed tracing across services
- **[Collector Configuration](/collector/config/)** — Tune batch sizes and connection settings
- **[ClickHouse Schema](/storage/schema/)** — Full column reference and index strategy
