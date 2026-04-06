---
title: "TypeScript SDK: Distributed Tracing"
description: Distributed tracing with the Aires TypeScript SDK — trace IDs, span IDs, parent spans, subtraces, and cross-service propagation.
---

## Concepts

Aires uses a trace model compatible with W3C Trace Context and OpenTelemetry:

- **Trace ID** — identifies an entire distributed operation spanning multiple services. All events belonging to the same request share a trace ID.
- **Span ID** — identifies a single unit of work within a trace (e.g. one HTTP handler, one database query, one RPC call).
- **Parent Span ID** — links a span to its parent, forming a tree structure.
- **Subtrace ID** — groups events within a nested sub-operation (e.g. an AI agent's multi-step task within a larger request).

## Creating Spans

Use `aires.span()` to create a span event:

```typescript
import { aires } from "@aires/sdk"
import { randomUUID } from "crypto"

const traceId = randomUUID()
const spanId = randomUUID()

// Create a span for an HTTP handler
aires.span("POST /api/tasks", {
  traceId,
  spanId,
  category: "http",
  attr: {
    "http.method": "POST",
    "http.path": "/api/tasks",
  },
})
```

## Span Hierarchies

Link child spans to parents using `parentSpanId`:

```typescript
const traceId = randomUUID()

// Root span: HTTP request
const httpSpanId = randomUUID()
aires.span("POST /api/tasks", {
  traceId,
  spanId: httpSpanId,
  category: "http",
})

// Child span: database query
const dbSpanId = randomUUID()
aires.span("INSERT INTO tasks", {
  traceId,
  spanId: dbSpanId,
  parentSpanId: httpSpanId,  // ← links to parent
  category: "db",
  attr: {
    "db.system": "postgres",
    "db.operation": "INSERT",
    "db.table": "tasks",
  },
})

// Child span: cache write
const cacheSpanId = randomUUID()
aires.span("SET task:123", {
  traceId,
  spanId: cacheSpanId,
  parentSpanId: httpSpanId,  // ← same parent as db span
  category: "cache",
  attr: {
    "cache.system": "redis",
    "cache.operation": "SET",
  },
})
```

This creates a span tree:

```
POST /api/tasks (httpSpanId)
├── INSERT INTO tasks (dbSpanId)
└── SET task:123 (cacheSpanId)
```

## Cross-Service Propagation

To propagate trace context across services, pass the `traceId` and current `spanId` (as the parent) in your service-to-service calls.

### HTTP Headers

Use the W3C `traceparent` format or custom headers:

```typescript
// Service A: outgoing request
const traceId = randomUUID()
const spanId = randomUUID()

aires.span("call billing service", {
  traceId,
  spanId,
  category: "rpc",
})

const response = await fetch("https://billing-service/api/charge", {
  method: "POST",
  headers: {
    "x-trace-id": traceId,
    "x-parent-span-id": spanId,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ amount: 4999 }),
})
```

```typescript
// Service B: incoming request
app.post("/api/charge", (req) => {
  const traceId = req.headers["x-trace-id"]
  const parentSpanId = req.headers["x-parent-span-id"]
  const spanId = randomUUID()

  aires.span("POST /api/charge", {
    traceId,
    spanId,
    parentSpanId,  // ← links to Service A's span
    category: "http",
  })

  // ... handle request
})
```

### gRPC Metadata

For gRPC services, propagate via metadata:

```typescript
// Client side
const metadata = new grpc.Metadata()
metadata.add("x-trace-id", traceId)
metadata.add("x-parent-span-id", currentSpanId)

client.processTask(request, metadata, (err, response) => {
  // ...
})
```

## Subtraces

Subtraces group events within a nested operation that has its own logical scope but belongs to a larger trace. This is particularly useful for AI agent workflows:

```typescript
const traceId = randomUUID()
const subtraceId = randomUUID()

// Parent request creates the trace
aires.span("POST /api/agent/run", {
  traceId,
  spanId: randomUUID(),
  category: "http",
})

// Agent execution creates a subtrace
aires.info("agent started planning", {
  traceId,
  subtraceId,        // ← groups all agent events
  agentId: "agent-planner",
  category: "ai",
})

aires.info("agent calling tool: search", {
  traceId,
  subtraceId,        // ← same subtrace
  agentId: "agent-planner",
  category: "ai",
  data: {
    tool: { name: "search", args: { query: "quarterly revenue" } },
  },
})

aires.info("agent completed", {
  traceId,
  subtraceId,        // ← same subtrace
  agentId: "agent-planner",
  category: "ai",
})
```

Query a subtrace:

```sql
SELECT timestamp, message, agent_id, category
FROM events
WHERE subtrace_id = 'your-subtrace-id'
ORDER BY timestamp;
```

## Timing Spans

To record span duration, log the start and end events with timing attributes:

```typescript
const traceId = randomUUID()
const spanId = randomUUID()
const start = performance.now()

// ... do work ...

const durationMs = performance.now() - start

aires.span("process-task", {
  traceId,
  spanId,
  attr: {
    "duration_ms": durationMs.toFixed(2),
    "status": "ok",
  },
})
```

For HTTP spans, use the built-in `http.durationMs` field:

```typescript
aires.info("request completed", {
  traceId,
  spanId,
  category: "http",
  http: {
    method: "POST",
    path: "/api/tasks",
    status: 201,
    durationMs: 47,
  },
})
```

## Querying Traces

### Reconstruct a full trace

```sql
SELECT
    timestamp,
    severity,
    message,
    span_id,
    parent_span_id,
    category,
    kind,
    http_duration_ms
FROM events
WHERE trace_id = 'your-trace-id'
ORDER BY timestamp;
```

### Find slow traces

```sql
SELECT
    trace_id,
    min(timestamp) AS started,
    max(timestamp) AS ended,
    date_diff('millisecond', min(timestamp), max(timestamp)) AS duration_ms,
    count() AS span_count
FROM events
WHERE service = 'my-api'
  AND timestamp > now() - INTERVAL 1 HOUR
GROUP BY trace_id
HAVING duration_ms > 1000
ORDER BY duration_ms DESC
LIMIT 20;
```

### Find traces with errors

```sql
SELECT DISTINCT trace_id, min(timestamp) AS first_error
FROM events
WHERE severity = 'error'
  AND trace_id != ''
  AND timestamp > now() - INTERVAL 1 HOUR
GROUP BY trace_id
ORDER BY first_error DESC;
```
