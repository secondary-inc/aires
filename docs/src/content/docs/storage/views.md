---
title: "Storage: Materialized Views"
description: Pre-aggregated materialized views for fast dashboards — error rates, HTTP latency percentiles, and custom views.
---

## Overview

Materialized views in ClickHouse run a query on every INSERT and write the results to a target table. For Aires, this means pre-aggregated metrics are updated in real-time as events are ingested — no batch jobs, no cron, no delay.

Views transform raw events into compact, pre-computed tables that power dashboards without scanning millions of rows.

## mv_error_rate

Tracks error counts per service per minute.

### Target Table

```sql
CREATE TABLE IF NOT EXISTS aires.error_rate
(
    minute       DateTime,
    service      LowCardinality(String),
    environment  LowCardinality(String),
    error_count  UInt64,
    total_count  UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toDate(minute)
ORDER BY (service, environment, minute)
TTL minute + INTERVAL 90 DAY;
```

### View

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS aires.mv_error_rate
TO aires.error_rate
AS
SELECT
    toStartOfMinute(timestamp) AS minute,
    service,
    environment,
    countIf(severity IN ('error', 'fatal')) AS error_count,
    count() AS total_count
FROM aires.events
GROUP BY minute, service, environment;
```

### Querying

```sql
-- Error rate per service over the last hour
SELECT
    minute,
    service,
    error_count,
    total_count,
    round(error_count / total_count * 100, 2) AS error_rate_pct
FROM aires.error_rate
WHERE minute > now() - INTERVAL 1 HOUR
ORDER BY minute DESC, service;
```

```sql
-- Services with error rate > 5% in the last 15 minutes
SELECT
    service,
    sum(error_count) AS errors,
    sum(total_count) AS total,
    round(errors / total * 100, 2) AS error_rate_pct
FROM aires.error_rate
WHERE minute > now() - INTERVAL 15 MINUTE
GROUP BY service
HAVING error_rate_pct > 5
ORDER BY error_rate_pct DESC;
```

## mv_http_latency

Tracks HTTP latency percentiles per endpoint per minute.

### Target Table

```sql
CREATE TABLE IF NOT EXISTS aires.http_latency
(
    minute          DateTime,
    service         LowCardinality(String),
    http_method     LowCardinality(String),
    http_path       String,
    request_count   UInt64,
    error_count     UInt64,
    duration_sum    Float64,
    duration_quantiles AggregateFunction(quantiles(0.5, 0.95, 0.99), Float64)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toDate(minute)
ORDER BY (service, http_method, http_path, minute)
TTL minute + INTERVAL 90 DAY;
```

### View

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS aires.mv_http_latency
TO aires.http_latency
AS
SELECT
    toStartOfMinute(timestamp) AS minute,
    service,
    http_method,
    http_path,
    count() AS request_count,
    countIf(http_status_code >= 400) AS error_count,
    sum(http_duration_ms) AS duration_sum,
    quantilesState(0.5, 0.95, 0.99)(toFloat64(http_duration_ms)) AS duration_quantiles
FROM aires.events
WHERE category = 'http'
  AND http_path != ''
GROUP BY minute, service, http_method, http_path;
```

### Querying

```sql
-- Latency percentiles per endpoint (last hour)
SELECT
    service,
    http_method,
    http_path,
    sum(request_count) AS requests,
    sum(error_count) AS errors,
    round(quantilesMerge(0.5, 0.95, 0.99)(duration_quantiles)[1], 1) AS p50_ms,
    round(quantilesMerge(0.5, 0.95, 0.99)(duration_quantiles)[2], 1) AS p95_ms,
    round(quantilesMerge(0.5, 0.95, 0.99)(duration_quantiles)[3], 1) AS p99_ms
FROM aires.http_latency
WHERE minute > now() - INTERVAL 1 HOUR
GROUP BY service, http_method, http_path
ORDER BY requests DESC;
```

```sql
-- Endpoints with p99 > 1 second
SELECT
    service,
    http_method,
    http_path,
    sum(request_count) AS requests,
    round(quantilesMerge(0.5, 0.95, 0.99)(duration_quantiles)[3], 1) AS p99_ms
FROM aires.http_latency
WHERE minute > now() - INTERVAL 1 HOUR
GROUP BY service, http_method, http_path
HAVING p99_ms > 1000
ORDER BY p99_ms DESC;
```

## Creating Custom Views

### Example: Agent Activity View

Track AI agent activity per agent per hour:

```sql
-- Target table
CREATE TABLE aires.agent_activity
(
    hour          DateTime,
    agent_id      String,
    service       LowCardinality(String),
    event_count   UInt64,
    error_count   UInt64,
    llm_calls     UInt64,
    tool_calls    UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toDate(hour)
ORDER BY (agent_id, service, hour)
TTL hour + INTERVAL 90 DAY;

-- Materialized view
CREATE MATERIALIZED VIEW aires.mv_agent_activity
TO aires.agent_activity
AS
SELECT
    toStartOfHour(timestamp) AS hour,
    agent_id,
    service,
    count() AS event_count,
    countIf(severity IN ('error', 'fatal')) AS error_count,
    countIf(has(tags, 'llm-call')) AS llm_calls,
    countIf(has(tags, 'tool-use')) AS tool_calls
FROM aires.events
WHERE category = 'ai'
  AND agent_id != ''
GROUP BY hour, agent_id, service;
```

### Example: Service Health View

Track overall service health metrics per minute:

```sql
-- Target table
CREATE TABLE aires.service_health
(
    minute        DateTime,
    service       LowCardinality(String),
    environment   LowCardinality(String),
    total_events  UInt64,
    error_events  UInt64,
    http_requests UInt64,
    http_errors   UInt64,
    avg_duration  Float64
)
ENGINE = SummingMergeTree()
PARTITION BY toDate(minute)
ORDER BY (service, environment, minute)
TTL minute + INTERVAL 30 DAY;

-- Materialized view
CREATE MATERIALIZED VIEW aires.mv_service_health
TO aires.service_health
AS
SELECT
    toStartOfMinute(timestamp) AS minute,
    service,
    environment,
    count() AS total_events,
    countIf(severity IN ('error', 'fatal')) AS error_events,
    countIf(category = 'http') AS http_requests,
    countIf(category = 'http' AND http_status_code >= 400) AS http_errors,
    avgIf(http_duration_ms, category = 'http' AND http_duration_ms > 0) AS avg_duration
FROM aires.events
GROUP BY minute, service, environment;
```

## Best Practices

### Use the Right Engine

| Engine | Use Case |
|--------|----------|
| `SummingMergeTree` | Additive metrics (counts, sums). ClickHouse automatically sums columns on merge. |
| `AggregatingMergeTree` | Complex aggregations (percentiles, quantiles). Uses `State`/`Merge` functions. |
| `ReplacingMergeTree` | Last-value semantics (latest status per entity). |

### Keep Views Focused

Each view should answer one question:
- `mv_error_rate` — "What is the error rate per service?"
- `mv_http_latency` — "What are the latency percentiles per endpoint?"
- `mv_agent_activity` — "How active are my agents?"

Avoid creating monolithic views that aggregate everything. Multiple small views are easier to understand, maintain, and query.

### Match TTL to the Source Table

Set the target table's TTL to match or exceed the source table's TTL. If the source keeps 30 days, the view should keep at least 30 days (often longer, since aggregated data is much smaller).

### Manage View Lifecycle

```sql
-- List all materialized views
SELECT name, as_select
FROM system.tables
WHERE database = 'aires' AND engine = 'MaterializedView';

-- Drop a view (stops processing, keeps target table)
DROP VIEW aires.mv_error_rate;

-- Drop the target table too
DROP TABLE aires.error_rate;

-- Recreate (will only process new data from this point)
-- Existing data in aires.events is NOT retroactively processed.
```

### Backfill After Creating a View

Materialized views only process new inserts. To backfill from existing data:

```sql
-- Manually insert historical data into the target table
INSERT INTO aires.error_rate
SELECT
    toStartOfMinute(timestamp) AS minute,
    service,
    environment,
    countIf(severity IN ('error', 'fatal')) AS error_count,
    count() AS total_count
FROM aires.events
WHERE timestamp > now() - INTERVAL 7 DAY
GROUP BY minute, service, environment;
```
