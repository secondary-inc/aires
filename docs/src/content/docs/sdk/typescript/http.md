---
title: "TypeScript SDK: HTTP Middleware"
description: Automatic HTTP request/response instrumentation for Elysia, Express, and Bun servers.
---

## Overview

The Aires TypeScript SDK provides patterns for automatic HTTP instrumentation. These middleware functions capture method, path, status code, duration, and request/response sizes for every HTTP request.

## Elysia Middleware

[Elysia](https://elysiajs.com) is the recommended HTTP framework for Bun. Create an Aires plugin:

```typescript
import { aires } from "@aires/sdk"
import { Elysia } from "elysia"
import { randomUUID } from "crypto"

const airesPlugin = new Elysia({ name: "aires" })
  .derive(({ request }) => {
    const traceId = request.headers.get("x-trace-id") ?? randomUUID()
    const parentSpanId = request.headers.get("x-parent-span-id") ?? undefined
    const spanId = randomUUID()
    const start = performance.now()

    return {
      traceId,
      spanId,
      parentSpanId,
      requestStart: start,
    }
  })
  .onAfterResponse(({ request, traceId, spanId, parentSpanId, requestStart, set }) => {
    const durationMs = Math.round(performance.now() - requestStart)
    const url = new URL(request.url)
    const status = set.status ?? 200

    aires.info(`${request.method} ${url.pathname}`, {
      traceId,
      spanId,
      parentSpanId,
      category: "http",
      http: {
        method: request.method,
        path: url.pathname,
        status: typeof status === "number" ? status : 200,
        durationMs,
      },
      attr: {
        "http.user_agent": request.headers.get("user-agent") ?? "",
        "http.content_length": request.headers.get("content-length") ?? "0",
      },
      tags: status >= 400 ? ["error"] : [],
    })

    // Record latency metric
    aires.metric("http.request.duration_ms", durationMs, {
      attr: {
        method: request.method,
        path: url.pathname,
        status: String(status),
      },
    })
  })
  .onError(({ error, request, traceId, spanId }) => {
    const url = new URL(request.url)

    aires.error(`${request.method} ${url.pathname} failed`, {
      traceId,
      spanId,
      category: "http",
      error: {
        type: error.constructor.name,
        message: error.message,
        stack: error.stack ?? "",
        handled: false,
      },
    })
  })

// Usage
const app = new Elysia()
  .use(airesPlugin)
  .get("/api/health", () => ({ status: "ok" }))
  .post("/api/tasks", ({ body, traceId }) => {
    // traceId is available in all handlers
    aires.info("creating task", { traceId, category: "task" })
    return { id: "task-123" }
  })
  .listen(3000)
```

## Express Middleware

For Express (Node.js) applications:

```typescript
import { aires } from "@aires/sdk"
import express from "express"
import { randomUUID } from "crypto"

function airesMiddleware() {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const traceId = (req.headers["x-trace-id"] as string) ?? randomUUID()
    const parentSpanId = req.headers["x-parent-span-id"] as string | undefined
    const spanId = randomUUID()
    const start = performance.now()

    // Attach trace context to the request for downstream handlers
    req.traceId = traceId
    req.spanId = spanId

    // Capture when the response finishes
    res.on("finish", () => {
      const durationMs = Math.round(performance.now() - start)

      aires.info(`${req.method} ${req.path}`, {
        traceId,
        spanId,
        parentSpanId,
        category: "http",
        http: {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs,
        },
        attr: {
          "http.user_agent": req.headers["user-agent"] ?? "",
          "http.remote_addr": req.ip ?? "",
        },
      })

      aires.metric("http.request.duration_ms", durationMs, {
        attr: {
          method: req.method,
          path: req.path,
          status: String(res.statusCode),
        },
      })
    })

    next()
  }
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      traceId: string
      spanId: string
    }
  }
}

// Usage
const app = express()
app.use(airesMiddleware())

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" })
})

app.post("/api/tasks", (req, res) => {
  aires.info("creating task", {
    traceId: req.traceId,
    category: "task",
  })
  res.status(201).json({ id: "task-123" })
})

app.listen(3000)
```

## Bun.serve Middleware

For bare `Bun.serve` without a framework:

```typescript
import { aires } from "@aires/sdk"
import { randomUUID } from "crypto"

function withAires(
  handler: (req: Request, traceContext: { traceId: string; spanId: string }) => Response | Promise<Response>
) {
  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? randomUUID()
    const spanId = randomUUID()
    const start = performance.now()
    const url = new URL(req.url)

    let status = 200
    let response: Response

    try {
      response = await handler(req, { traceId, spanId })
      status = response.status
    } catch (err: any) {
      status = 500
      aires.error(`${req.method} ${url.pathname} unhandled error`, {
        traceId,
        spanId,
        category: "http",
        error: {
          type: err.constructor.name,
          message: err.message,
          stack: err.stack ?? "",
          handled: false,
        },
      })
      response = new Response("Internal Server Error", { status: 500 })
    }

    const durationMs = Math.round(performance.now() - start)

    aires.info(`${req.method} ${url.pathname}`, {
      traceId,
      spanId,
      category: "http",
      http: {
        method: req.method,
        path: url.pathname,
        status,
        durationMs,
      },
    })

    aires.metric("http.request.duration_ms", durationMs, {
      attr: {
        method: req.method,
        path: url.pathname,
        status: String(status),
      },
    })

    return response
  }
}

// Usage
Bun.serve({
  port: 3000,
  fetch: withAires(async (req, { traceId, spanId }) => {
    const url = new URL(req.url)

    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok" })
    }

    if (url.pathname === "/api/tasks" && req.method === "POST") {
      aires.info("creating task", { traceId, spanId, category: "task" })
      return Response.json({ id: "task-123" }, { status: 201 })
    }

    return new Response("Not Found", { status: 404 })
  }),
})
```

## What Gets Captured

All middleware patterns capture:

| Field | Source | ClickHouse Column |
|-------|--------|-------------------|
| HTTP method | `req.method` | `http_method` |
| URL path | `req.url` / `req.path` | `http_path` |
| Status code | `res.statusCode` / `response.status` | `http_status_code` |
| Duration | `performance.now()` delta | `http_duration_ms` |
| User agent | `User-Agent` header | `attributes['http.user_agent']` |
| Remote address | `req.ip` / connection info | `attributes['http.remote_addr']` |

## Dashboard Queries

### Request rate by endpoint

```sql
SELECT
    http_path,
    http_method,
    count() AS requests,
    countIf(http_status_code >= 400) AS errors,
    round(errors / requests * 100, 2) AS error_rate
FROM events
WHERE category = 'http'
  AND timestamp > now() - INTERVAL 1 HOUR
GROUP BY http_path, http_method
ORDER BY requests DESC;
```

### Latency percentiles

```sql
SELECT
    http_path,
    quantile(0.5)(http_duration_ms) AS p50,
    quantile(0.95)(http_duration_ms) AS p95,
    quantile(0.99)(http_duration_ms) AS p99,
    max(http_duration_ms) AS max_ms
FROM events
WHERE category = 'http'
  AND timestamp > now() - INTERVAL 1 HOUR
GROUP BY http_path
ORDER BY p95 DESC;
```

### Slow requests

```sql
SELECT
    timestamp,
    http_method,
    http_path,
    http_status_code,
    http_duration_ms,
    trace_id
FROM events
WHERE category = 'http'
  AND http_duration_ms > 1000
  AND timestamp > now() - INTERVAL 1 HOUR
ORDER BY http_duration_ms DESC
LIMIT 20;
```
