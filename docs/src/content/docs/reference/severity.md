---
title: "Reference: Severity Levels"
description: Aires severity levels — trace, debug, info, warn, error, fatal. Proto enum values, when to use each, and ClickHouse storage.
---

## Severity Levels

Aires defines six severity levels, aligned with common logging conventions and the OpenTelemetry severity number mapping.

| Level | Proto Enum | Proto Value | ClickHouse String | OTel Range |
|-------|-----------|-------------|-------------------|------------|
| **Trace** | `TRACE` | `1` | `"trace"` | 1-4 |
| **Debug** | `DEBUG` | `2` | `"debug"` | 5-8 |
| **Info** | `INFO` | `3` | `"info"` | 9-12 |
| **Warn** | `WARN` | `4` | `"warn"` | 13-16 |
| **Error** | `ERROR` | `5` | `"error"` | 17-20 |
| **Fatal** | `FATAL` | `6` | `"fatal"` | 21-24 |

There is also `SEVERITY_UNSPECIFIED = 0`, stored as `"unspecified"` in ClickHouse.

## When to Use Each Level

### TRACE (1)

The finest-grained diagnostic information. Use for detailed internal state that is only useful when actively debugging a specific problem.

```typescript
aires.trace("entering parseConfig", {
  attr: { configPath: "/etc/app/config.toml" },
})

aires.trace("cache lookup", {
  attr: { key: "user:42:profile", hit: "false" },
})
```

**When to use:**
- Function entry/exit in hot paths
- Cache hit/miss details
- Internal state machine transitions
- Loop iteration details

**Retention recommendation:** 1-7 days. Trace events are high-volume and rarely useful after the debugging session ends.

### DEBUG (2)

Development-time diagnostics. More useful than trace, but still too verbose for production monitoring.

```typescript
aires.debug("loaded 42 config entries", {
  attr: { source: "config.toml", duration_ms: "12" },
})

aires.debug("connection pool initialized", {
  attr: { pool: "primary", size: "10", idle: "10" },
})
```

**When to use:**
- Configuration loading results
- Connection establishment details
- Query plans or optimization decisions
- Feature flag evaluation results

**Retention recommendation:** 7-14 days.

### INFO (3)

Normal operational events. The default level for production. Use for events that an operator would want to see in a dashboard under normal conditions.

```typescript
aires.info("server listening on :3000", {
  attr: { host: "0.0.0.0", port: "3000", tls: "true" },
})

aires.info("POST /api/tasks", {
  category: "http",
  http: { method: "POST", path: "/api/tasks", status: 201, durationMs: 47 },
})

aires.info("deployment complete", {
  tags: ["deploy", "v1.2.0"],
  attr: { replicas: "3", duration_s: "45" },
})
```

**When to use:**
- Server startup and shutdown
- Request/response logging (HTTP, gRPC)
- Successful completions of important operations
- Deployment and scaling events
- User authentication events

**Retention recommendation:** 30 days.

### WARN (4)

Potential problems that may or may not require action. The system is still operating correctly, but something unexpected happened.

```typescript
aires.warn("connection pool at 80% capacity", {
  attr: { pool: "primary", active: "8", max: "10" },
})

aires.warn("retry attempt 2/3", {
  attr: { operation: "s3-upload", backoff_ms: "200" },
})

aires.warn("deprecated API endpoint called", {
  category: "http",
  attr: { path: "/api/v1/users", deprecatedSince: "2024-06-01" },
})
```

**When to use:**
- Resource utilization approaching limits
- Retry attempts (but not final failures)
- Deprecated feature usage
- Configuration values that may cause issues
- Clock skew or timing anomalies

**Retention recommendation:** 30-90 days.

### ERROR (5)

Errors that need investigation and potentially immediate action. The operation failed, but the system is still running.

```typescript
aires.error("database query failed", {
  category: "db",
  error: {
    type: "PostgresError",
    message: "connection refused",
    stack: "...",
    handled: true,
  },
})

aires.error("payment processing failed", {
  category: "payment",
  attr: { orderId: "ord-456", reason: "card_declined" },
  error: {
    type: "StripeCardError",
    message: "Your card was declined",
    handled: true,
  },
})
```

**When to use:**
- Caught exceptions that affect user-facing functionality
- Failed external API calls (after all retries exhausted)
- Data validation failures
- Authentication/authorization failures
- Business logic errors

**Retention recommendation:** 90 days.

### FATAL (6)

Unrecoverable errors. The system cannot continue operating and is shutting down (or a critical subsystem has failed).

```typescript
aires.fatal("database unreachable after all retries", {
  category: "db",
  error: {
    type: "ConnectionError",
    message: "all 3 retries exhausted",
    handled: false,
  },
})

aires.fatal("out of memory", {
  attr: { rss_bytes: "8589934592", limit_bytes: "8589934592" },
})
```

**When to use:**
- Unrecoverable database connection failures
- Out of memory conditions
- Corrupted state that prevents operation
- Critical dependency unavailable
- Uncaught exceptions that crash the process

**Retention recommendation:** 90+ days. Fatal events are rare and always worth investigating.

## Protobuf Definition

```protobuf
enum Severity {
  SEVERITY_UNSPECIFIED = 0;
  TRACE = 1;
  DEBUG = 2;
  INFO = 3;
  WARN = 4;
  ERROR = 5;
  FATAL = 6;
}
```

## SDK Mapping

### Rust

```rust
use aires_sdk::Severity;

// Enum variants
Severity::Trace   // → proto value 1
Severity::Debug   // → proto value 2
Severity::Info    // → proto value 3
Severity::Warn    // → proto value 4
Severity::Error   // → proto value 5
Severity::Fatal   // → proto value 6
```

### TypeScript

```typescript
// String literals used as method names
aires.trace(msg)   // → severity TRACE (1)
aires.debug(msg)   // → severity DEBUG (2)
aires.info(msg)    // → severity INFO (3)
aires.warn(msg)    // → severity WARN (4)
aires.error(msg)   // → severity ERROR (5)
aires.fatal(msg)   // → severity FATAL (6)
```

### Python

```python
# Module-level functions
aires.trace(msg)   # → severity TRACE (1)
aires.debug(msg)   # → severity DEBUG (2)
aires.info(msg)    # → severity INFO (3)
aires.warn(msg)    # → severity WARN (4)
aires.error(msg)   # → severity ERROR (5)
aires.fatal(msg)   # → severity FATAL (6)
```

## Collector Transformation

The collector converts the proto enum integer to a string for ClickHouse storage:

```elixir
# In AiresCollector.Transform
defp severity_to_string(0), do: "unspecified"
defp severity_to_string(1), do: "trace"
defp severity_to_string(2), do: "debug"
defp severity_to_string(3), do: "info"
defp severity_to_string(4), do: "warn"
defp severity_to_string(5), do: "error"
defp severity_to_string(6), do: "fatal"
defp severity_to_string(_), do: "unspecified"
```

Strings are used in ClickHouse (rather than integers) because:
1. They're human-readable in query results
2. `LowCardinality(String)` with only 7 values is as efficient as an enum
3. They're compatible with OpenTelemetry severity text

## ClickHouse Queries by Severity

```sql
-- Count by severity (last hour)
SELECT severity, count() AS events
FROM aires.events
WHERE timestamp > now() - INTERVAL 1 HOUR
GROUP BY severity
ORDER BY
    CASE severity
        WHEN 'trace' THEN 1
        WHEN 'debug' THEN 2
        WHEN 'info' THEN 3
        WHEN 'warn' THEN 4
        WHEN 'error' THEN 5
        WHEN 'fatal' THEN 6
        ELSE 0
    END;

-- Errors and fatals only
SELECT * FROM aires.events
WHERE severity IN ('error', 'fatal')
  AND timestamp > now() - INTERVAL 1 HOUR
ORDER BY timestamp DESC;

-- Error rate (errors+fatals / total)
SELECT
    toStartOfMinute(timestamp) AS minute,
    countIf(severity IN ('error', 'fatal')) AS errors,
    count() AS total,
    round(errors / total * 100, 2) AS error_rate_pct
FROM aires.events
WHERE timestamp > now() - INTERVAL 1 HOUR
GROUP BY minute
ORDER BY minute;
```
