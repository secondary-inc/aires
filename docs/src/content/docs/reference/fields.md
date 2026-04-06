---
title: "Reference: Event Fields"
description: Complete event field reference table — field name, type, ClickHouse column, example value, and whether it's indexed.
---

## Field Reference

Every field on an Aires event, mapped from the Protobuf schema to the ClickHouse column.

### Identity

| Proto Field | ClickHouse Column | CH Type | Indexed | Example | Description |
|-------------|-------------------|---------|---------|---------|-------------|
| `id` | `id` | `String` | Primary key | `"0192b3a4-..."` | UUID v7, time-ordered |
| `timestamp_ns` | `timestamp` | `DateTime64(9, 'UTC')` | Sort key | `2024-12-01 15:04:05.123456789` | Nanosecond event timestamp |
| `observed_timestamp_ns` | — | — | — | — | Collector receive time (not stored separately) |

### Service Context

| Proto Field | ClickHouse Column | CH Type | Indexed | Example | Description |
|-------------|-------------------|---------|---------|---------|-------------|
| `service` | `service` | `LowCardinality(String)` | Sort key (1st) | `"workforce-api"` | Service name |
| `environment` | `environment` | `LowCardinality(String)` | No | `"production"` | Environment |
| `host` | `host` | `String` | No | `"ip-10-0-1-42"` | Hostname |
| `instance` | `instance` | `String` | No | `"replica-3"` | Instance ID |

### Content

| Proto Field | ClickHouse Column | CH Type | Indexed | Example | Description |
|-------------|-------------------|---------|---------|---------|-------------|
| `severity` | `severity` | `LowCardinality(String)` | Sort key (2nd) | `"error"` | Stored as string, not enum int |
| `message` | `message` | `String` | Token BF | `"request failed"` | Searchable log message |
| `display_text` | `display_text` | `String` | No | `"\x1b[31m✗ request failed\x1b[0m"` | Formatted display text |
| `body` | `body` | `String` | No | `"<base64>"` | Raw binary body |

### Tracing

| Proto Field | ClickHouse Column | CH Type | Indexed | Example | Description |
|-------------|-------------------|---------|---------|---------|-------------|
| `trace_id` | `trace_id` | `String` | Bloom filter | `"abc-123-def-456"` | Distributed trace ID |
| `span_id` | `span_id` | `String` | Bloom filter | `"span-001"` | Span ID |
| `parent_span_id` | `parent_span_id` | `String` | No | `"span-000"` | Parent span ID |
| `subtrace_id` | `subtrace_id` | `String` | No | `"sub-789"` | Sub-trace grouping ID |

### Session / User / Agent

| Proto Field | ClickHouse Column | CH Type | Indexed | Example | Description |
|-------------|-------------------|---------|---------|---------|-------------|
| `session_id` | `session_id` | `String` | Bloom filter | `"sess-user42-abc"` | Session ID |
| `user_id` | `user_id` | `String` | No | `"user-42"` | Authenticated user |
| `agent_id` | `agent_id` | `String` | No | `"planner-v2"` | AI agent ID |

### Source Location

| Proto Field | ClickHouse Column | CH Type | Indexed | Example | Description |
|-------------|-------------------|---------|---------|---------|-------------|
| `source_file` | `source_file` | `String` | No | `"src/handler.ts"` | File path |
| `source_line` | `source_line` | `UInt32` | No | `42` | Line number |
| `source_function` | `source_function` | `String` | No | `"processTask"` | Function name |

### Categorization

| Proto Field | ClickHouse Column | CH Type | Indexed | Example | Description |
|-------------|-------------------|---------|---------|---------|-------------|
| `category` | `category` | `LowCardinality(String)` | No | `"http"` | Event category |
| `kind` | `kind` | `LowCardinality(String)` | No | `"span"` | Event kind |
| `tags` | `tags` | `Array(String)` | No | `["api", "v2"]` | Free-form tags |

### Attributes and Data

| Proto Field | ClickHouse Column | CH Type | Indexed | Example | Description |
|-------------|-------------------|---------|---------|---------|-------------|
| `attributes` | — | — | — | — | Flattened: known keys extracted, others stored in the row |
| `data` | — | — | — | — | JSON blobs stored in the row (future: dedicated map column) |

### HTTP (from `HttpInfo`)

| Proto Field | ClickHouse Column | CH Type | Indexed | Example | Description |
|-------------|-------------------|---------|---------|---------|-------------|
| `http.method` | `http_method` | `LowCardinality(String)` | No | `"POST"` | HTTP method |
| `http.url` | — | — | — | — | Not stored (path is stored) |
| `http.path` | `http_path` | `String` | No | `"/api/tasks"` | URL path |
| `http.status_code` | `http_status_code` | `UInt16` | No | `201` | Response status |
| `http.request_size` | — | — | — | — | Not stored (available via attributes) |
| `http.response_size` | — | — | — | — | Not stored (available via attributes) |
| `http.duration_ms` | `http_duration_ms` | `Int64` | No | `47` | Duration in ms |
| `http.user_agent` | — | — | — | — | Not stored (available via attributes) |
| `http.remote_addr` | — | — | — | — | Not stored (available via attributes) |

### Metrics (from `MetricValue`)

| Proto Field | ClickHouse Column | CH Type | Indexed | Example | Description |
|-------------|-------------------|---------|---------|---------|-------------|
| `metric.name` | `metric_name` | `LowCardinality(String)` | No | `"http.request.duration_ms"` | Metric name |
| `metric.value` | `metric_value` | `Float64` | No | `47.2` | Metric value |
| `metric.unit` | — | — | — | — | Not stored (convention in name) |
| `metric.type` | — | — | — | — | Not stored (convention in name) |

### Errors (from `ErrorInfo`)

| Proto Field | ClickHouse Column | CH Type | Indexed | Example | Description |
|-------------|-------------------|---------|---------|---------|-------------|
| `error.type` | `error_type` | `LowCardinality(String)` | No | `"DatabaseError"` | Error class |
| `error.message` | `error_message` | `String` | No | `"connection refused"` | Error message |
| `error.stack` | `error_stack` | `String` | No | `"Error: ...\n  at ..."` | Stack trace |
| `error.handled` | `error_handled` | `Bool` | No | `true` | Caught or unhandled |

### SDK Metadata (from `EventBatch`)

| Proto Field | ClickHouse Column | CH Type | Indexed | Example | Description |
|-------------|-------------------|---------|---------|---------|-------------|
| `sdk_name` | `sdk_name` | `LowCardinality(String)` | No | `"aires-sdk-ts"` | SDK name |
| `sdk_version` | `sdk_version` | `LowCardinality(String)` | No | `"0.1.0"` | SDK version |
| `sdk_language` | `sdk_language` | `LowCardinality(String)` | No | `"typescript"` | SDK language |

## Index Summary

| Index | Column | Type | Purpose |
|-------|--------|------|---------|
| Primary key | `(service, severity, timestamp)` | Sort order | Optimizes filtering by service + severity + time |
| `idx_trace_id` | `trace_id` | `bloom_filter(0.01)` | Fast trace lookups |
| `idx_span_id` | `span_id` | `bloom_filter(0.01)` | Fast span lookups |
| `idx_session_id` | `session_id` | `bloom_filter(0.01)` | Fast session lookups |
| `idx_message` | `message` | `tokenbf_v1(10240, 3, 0)` | Full-text search on log messages |

## Query Patterns by Index

### Primary key (fastest)

```sql
-- All three sort key columns
WHERE service = 'my-api' AND severity = 'error' AND timestamp > now() - INTERVAL 1 HOUR

-- First two sort key columns
WHERE service = 'my-api' AND severity = 'error'

-- First sort key column only
WHERE service = 'my-api'
```

### Bloom filter (fast point lookups)

```sql
WHERE trace_id = 'abc-123'
WHERE span_id = 'span-001'
WHERE session_id = 'sess-789'
```

### Token bloom filter (text search)

```sql
WHERE message LIKE '%timeout%'
WHERE hasToken(message, 'connection')
```

### Non-indexed (full scan within partitions)

```sql
-- These scan all matching partitions — combine with time range for performance
WHERE category = 'http' AND timestamp > now() - INTERVAL 1 HOUR
WHERE agent_id = 'planner-v2' AND timestamp > now() - INTERVAL 1 HOUR
WHERE error_type = 'DatabaseError' AND timestamp > now() - INTERVAL 1 HOUR
```
