---
title: "TypeScript SDK: Metrics"
description: Recording metrics with the Aires TypeScript SDK — gauges, counters, histograms, naming conventions, and labels.
---

## Recording Metrics

Use `aires.metric()` to record a metric value:

```typescript
import { aires } from "@aires/sdk"

aires.metric("http.request.duration", 47.2, {
  tags: ["api"],
  attr: {
    method: "POST",
    path: "/api/tasks",
    status: "201",
  },
})
```

### Signature

```typescript
aires.metric(name: string, value: number, opts?: LogOptions): void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Metric name (dot-separated hierarchy) |
| `value` | `number` | Numeric value (integer or float) |
| `opts` | `LogOptions` | Optional — tags, attributes, trace context, etc. |

The call is non-blocking. The metric event is batched and shipped like any other event.

## Metric Types

In the protobuf schema, each metric has a `MetricType` enum. The TypeScript SDK creates metrics as `GAUGE` by default. You can indicate the type via naming conventions or attributes:

### Gauges

A gauge represents a point-in-time value that can go up or down. Use for current state:

```typescript
// Current connection count
aires.metric("db.connections.active", 42, {
  attr: { pool: "primary" },
})

// Memory usage
aires.metric("process.memory.rss_bytes", 134217728, {
  tags: ["runtime"],
})

// Queue depth
aires.metric("queue.depth", 1523, {
  attr: { queue: "task-processing" },
})
```

### Counters

A counter represents a cumulative value that only increases. Use for totals:

```typescript
// Total requests served
aires.metric("http.requests.total", 1, {
  attr: {
    method: "GET",
    path: "/api/users",
    status: "200",
  },
})

// Bytes transferred
aires.metric("http.response.bytes", 4096, {
  attr: { path: "/api/tasks" },
})

// Errors counted
aires.metric("errors.total", 1, {
  attr: {
    type: "DatabaseError",
    service: "user-service",
  },
})
```

### Histograms

Record individual observations that will be aggregated. Use for latencies and sizes:

```typescript
// Request latency
aires.metric("http.request.duration_ms", 47.2, {
  attr: {
    method: "POST",
    path: "/api/tasks",
    status: "201",
  },
})

// Database query time
aires.metric("db.query.duration_ms", 12.8, {
  attr: {
    operation: "SELECT",
    table: "tasks",
  },
})

// Payload size
aires.metric("http.request.size_bytes", 2048, {
  attr: { path: "/api/upload" },
})
```

Compute percentiles in ClickHouse:

```sql
SELECT
    attributes['path'] AS path,
    count() AS requests,
    quantile(0.5)(metric_value) AS p50_ms,
    quantile(0.95)(metric_value) AS p95_ms,
    quantile(0.99)(metric_value) AS p99_ms
FROM events
WHERE metric_name = 'http.request.duration_ms'
  AND timestamp > now() - INTERVAL 1 HOUR
GROUP BY path
ORDER BY requests DESC;
```

## Naming Conventions

Follow a dot-separated hierarchical naming convention:

```
{namespace}.{entity}.{measurement}[.{unit}]
```

Examples:

| Metric Name | Description |
|------------|-------------|
| `http.request.duration_ms` | HTTP request latency in milliseconds |
| `http.request.size_bytes` | Request body size in bytes |
| `http.response.size_bytes` | Response body size in bytes |
| `http.requests.total` | Total HTTP requests (counter) |
| `db.query.duration_ms` | Database query latency |
| `db.connections.active` | Active database connections (gauge) |
| `db.connections.idle` | Idle database connections (gauge) |
| `queue.depth` | Current queue depth (gauge) |
| `queue.processing.duration_ms` | Queue item processing time |
| `cache.hits.total` | Cache hit count (counter) |
| `cache.misses.total` | Cache miss count (counter) |
| `process.memory.rss_bytes` | Process RSS memory usage |
| `process.cpu.usage_percent` | Process CPU usage |
| `ai.llm.tokens.total` | LLM tokens consumed (counter) |
| `ai.llm.duration_ms` | LLM call latency |

## Labels and Dimensions

Use `attr` for metric dimensions/labels. These become filterable columns in ClickHouse:

```typescript
// Metric with dimensions
aires.metric("http.request.duration_ms", 47.2, {
  attr: {
    method: "POST",
    path: "/api/tasks",
    status: "201",
    region: "us-east-1",
  },
})
```

Use `tags` for free-form categorization:

```typescript
aires.metric("queue.depth", 1523, {
  tags: ["critical", "task-processing"],
})
```

### Cardinality Guidelines

Keep attribute values low-cardinality to avoid ClickHouse performance issues:

- **Good**: `method: "GET"`, `status: "200"`, `region: "us-east-1"`
- **Bad**: `userId: "user-12345"`, `requestId: "req-abc-..."`, `timestamp: "..."`

If you need to record high-cardinality dimensions, use `data` instead of `attr`:

```typescript
aires.metric("http.request.duration_ms", 47.2, {
  attr: {
    method: "POST",
    path: "/api/tasks",  // keep in attr for querying
  },
  data: {
    requestId: "req-abc-123",  // high-cardinality, stored but not indexed
    userId: "user-42",
  },
})
```

## Trace Context on Metrics

You can attach trace context to metrics to correlate them with specific requests:

```typescript
aires.metric("http.request.duration_ms", 47.2, {
  traceId: "trace-abc-123",
  spanId: "span-001",
  attr: {
    method: "POST",
    path: "/api/tasks",
  },
})
```

This lets you join metrics with trace events in ClickHouse:

```sql
-- Find the trace for the slowest request
SELECT trace_id, metric_value AS duration_ms
FROM events
WHERE metric_name = 'http.request.duration_ms'
  AND timestamp > now() - INTERVAL 1 HOUR
ORDER BY metric_value DESC
LIMIT 1;
```

## Aggregation Queries

Since metrics are stored as events, you aggregate them with SQL:

### Rate per minute

```sql
SELECT
    toStartOfMinute(timestamp) AS minute,
    count() AS requests_per_minute
FROM events
WHERE metric_name = 'http.requests.total'
  AND timestamp > now() - INTERVAL 1 HOUR
GROUP BY minute
ORDER BY minute;
```

### Average gauge over time

```sql
SELECT
    toStartOfMinute(timestamp) AS minute,
    avg(metric_value) AS avg_connections
FROM events
WHERE metric_name = 'db.connections.active'
  AND timestamp > now() - INTERVAL 1 HOUR
GROUP BY minute
ORDER BY minute;
```

### Error rate

```sql
SELECT
    toStartOfMinute(timestamp) AS minute,
    countIf(attributes['status'] >= '400') AS errors,
    count() AS total,
    round(errors / total * 100, 2) AS error_rate_pct
FROM events
WHERE metric_name = 'http.requests.total'
  AND timestamp > now() - INTERVAL 1 HOUR
GROUP BY minute
ORDER BY minute;
```
