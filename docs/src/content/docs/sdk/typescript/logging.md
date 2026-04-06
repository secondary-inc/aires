---
title: "TypeScript SDK: Logging"
description: All logging patterns in the Aires TypeScript SDK — severity levels, attributes, tags, structured data, error info, and source location.
---

## Severity Levels

The SDK provides six log methods corresponding to the Aires severity levels:

```typescript
import { aires } from "@aires/sdk"

aires.trace("entering parseConfig")     // Finest-grained debug info
aires.debug("loaded 42 config entries") // Development diagnostics
aires.info("server listening on :3000") // Normal operational events
aires.warn("connection pool at 80%")    // Potential problems
aires.error("request handler threw")    // Errors that need attention
aires.fatal("database unreachable")     // System cannot continue
```

All six methods share the same signature:

```typescript
aires.info(message: string, opts?: LogOptions): void
```

The call is non-blocking. The event is enqueued in the batch channel and returns immediately. Events are shipped to the collector in batches (default: 256 events or 500ms).

## LogOptions

Every logging method accepts an optional second argument with additional context:

```typescript
type LogOptions = {
  traceId?: string
  spanId?: string
  sessionId?: string
  userId?: string
  agentId?: string
  category?: string
  displayText?: string
  tags?: string[]
  attr?: Record<string, string>
  data?: Record<string, unknown>
  file?: string
  line?: number
  fn?: string
  http?: {
    method: string
    path: string
    status: number
    durationMs: number
  }
  error?: {
    type: string
    message: string
    stack?: string
    handled?: boolean
  }
}
```

## Attributes

String key-value pairs for structured metadata. Use `attr` for data you want to filter and search on:

```typescript
aires.info("user authenticated", {
  attr: {
    userId: "user-42",
    method: "oauth2",
    provider: "github",
    ip: "203.0.113.42",
  },
})
```

Attributes are stored in the `attributes` map column in ClickHouse and can be queried with:

```sql
SELECT * FROM events
WHERE attributes['userId'] = 'user-42';
```

## Tags

Free-form string tags for categorization and filtering:

```typescript
aires.info("deployment complete", {
  tags: ["deploy", "production", "v1.2.0"],
})
```

Query tags with ClickHouse array functions:

```sql
SELECT * FROM events
WHERE has(tags, 'deploy');
```

## Structured Data

Use `data` for arbitrary JSON objects that don't fit into string key-value pairs:

```typescript
aires.info("order processed", {
  data: {
    order: {
      id: "ord-789",
      items: 3,
      total: 149.99,
      currency: "USD",
    },
    customer: {
      tier: "premium",
      lifetime_orders: 42,
    },
  },
})
```

Data values are JSON-serialized and stored as bytes in the `data` map column. They're preserved as-is for later retrieval and analysis.

## Display Text

Use `displayText` for a formatted version of the log message. This can include ANSI escape codes for terminal rendering or rich text for UI display:

```typescript
aires.info("build complete", {
  displayText: "\x1b[32m✓\x1b[0m Build complete in 4.2s (42 modules)",
})
```

The `message` field should always be a plain, searchable string. `displayText` is for rendering only.

## Category

Categories group related events. Common categories:

```typescript
// HTTP request/response events
aires.info("GET /api/users", { category: "http" })

// Database operations
aires.info("SELECT users", { category: "db" })

// Authentication events
aires.warn("invalid token", { category: "auth" })

// AI agent events
aires.info("tool invoked", { category: "ai" })

// Kubernetes events
aires.info("pod scheduled", { category: "k8s" })
```

Filter by category in ClickHouse:

```sql
SELECT * FROM events
WHERE category = 'http'
  AND severity = 'error'
ORDER BY timestamp DESC;
```

## Error Information

Attach structured error details to any log event:

```typescript
try {
  await db.query("SELECT ...")
} catch (err) {
  aires.error("database query failed", {
    category: "db",
    error: {
      type: err.constructor.name,        // "PostgresError"
      message: err.message,              // "connection refused"
      stack: err.stack,                  // full stack trace
      handled: true,                     // was this caught?
    },
    attr: {
      query: "SELECT ...",
      database: "primary",
    },
  })
}
```

For unhandled errors:

```typescript
process.on("uncaughtException", (err) => {
  aires.fatal("uncaught exception", {
    error: {
      type: err.constructor.name,
      message: err.message,
      stack: err.stack,
      handled: false,
    },
  })
})
```

Query errors in ClickHouse:

```sql
-- Unhandled errors in the last hour
SELECT timestamp, service, error_type, error_message
FROM events
WHERE severity = 'error'
  AND error_handled = false
  AND timestamp > now() - INTERVAL 1 HOUR
ORDER BY timestamp DESC;
```

## Source Location

You can manually attach source file, line number, and function name to any event:

```typescript
aires.info("processing started", {
  file: "src/worker.ts",
  line: 42,
  fn: "processTask",
})
```

This is useful for custom logging wrappers. The Rust SDK's `aires_log!` macro captures source location automatically via `file!()` and `line!()`.

## HTTP Information

Attach HTTP request/response details to events:

```typescript
aires.info("request completed", {
  category: "http",
  http: {
    method: "POST",
    path: "/api/tasks",
    status: 201,
    durationMs: 47,
  },
  attr: {
    userAgent: req.headers["user-agent"],
    contentLength: req.headers["content-length"],
  },
})
```

See [HTTP Middleware](/sdk/typescript/http/) for automatic HTTP instrumentation.

## Tracing Context

Attach trace and span IDs to correlate events across services:

```typescript
aires.info("processing order", {
  traceId: "abc-123-def-456",
  spanId: "span-001",
  sessionId: "sess-789",
  userId: "user-42",
})
```

See [Tracing](/sdk/typescript/tracing/) for full distributed tracing documentation.

## Complete Example

Combining all options:

```typescript
aires.error("payment processing failed", {
  // Tracing
  traceId: "trace-abc-123",
  spanId: "span-payment-001",
  sessionId: "sess-checkout-789",
  userId: "user-42",
  agentId: "agent-billing",

  // Categorization
  category: "payment",
  tags: ["stripe", "card-declined", "retry-eligible"],

  // Display
  displayText: "\x1b[31m✗\x1b[0m Payment failed: card_declined (amount: $149.99)",

  // Structured attributes
  attr: {
    paymentId: "pay-xyz",
    amount: "14999",
    currency: "usd",
    stripeErrorCode: "card_declined",
  },

  // Rich data
  data: {
    stripeResponse: {
      id: "ch_xxx",
      status: "failed",
      decline_code: "insufficient_funds",
    },
  },

  // Error details
  error: {
    type: "StripeCardError",
    message: "Your card was declined.",
    stack: "StripeCardError: Your card was declined.\n    at processPayment (payment.ts:89)",
    handled: true,
  },

  // Source location
  file: "src/services/payment.ts",
  line: 89,
  fn: "processPayment",
})
```
