import { Elysia } from "elysia"
import { cors } from "@elysiajs/cors"
import { swagger } from "@elysiajs/swagger"
import { clickhouse } from "./clickhouse"

const PORT = parseInt(process.env.PORT || "4200")

const app = new Elysia()
  .use(swagger({
    documentation: {
      info: {
        title: "Aires API",
        version: "0.1.0",
        description: "Observability query and management API",
      },
    },
    path: "/api-docs",
  }))
  .use(cors())

  .get("/health", () => ({ status: "ok", ts: new Date().toISOString() }))

  // Query events
  .post("/events/search", async ({ body }) => {
    const { query, service, severity, traceId, from, to, limit, offset } = body as any
    const conditions: string[] = ["1=1"]
    const params: Record<string, unknown> = {}

    if (service) { conditions.push("service = {service:String}"); params.service = service }
    if (severity) { conditions.push("severity = {severity:String}"); params.severity = severity }
    if (traceId) { conditions.push("trace_id = {traceId:String}"); params.traceId = traceId }
    if (from) { conditions.push("timestamp >= {from:DateTime64(9)}"); params.from = from }
    if (to) { conditions.push("timestamp <= {to:DateTime64(9)}"); params.to = to }
    if (query) { conditions.push("message LIKE {query:String}"); params.query = `%${query}%` }

    const sql = `
      SELECT *
      FROM events
      WHERE ${conditions.join(" AND ")}
      ORDER BY timestamp DESC
      LIMIT {limit:UInt32}
      OFFSET {offset:UInt32}
    `
    params.limit = limit || 100
    params.offset = offset || 0

    const result = await clickhouse.query({ query: sql, query_params: params, format: "JSONEachRow" })
    const rows = await result.json()
    return rows
  })

  // Get a full trace
  .post("/traces/get", async ({ body }) => {
    const { traceId } = body as any
    const result = await clickhouse.query({
      query: `SELECT * FROM events WHERE trace_id = {traceId:String} ORDER BY timestamp ASC`,
      query_params: { traceId },
      format: "JSONEachRow",
    })
    return result.json()
  })

  // Service list
  .post("/services/list", async () => {
    const result = await clickhouse.query({
      query: `SELECT DISTINCT service FROM events ORDER BY service`,
      format: "JSONEachRow",
    })
    return result.json()
  })

  // Error rate dashboard
  .post("/dashboard/error-rate", async ({ body }) => {
    const { service, hours } = body as any
    const result = await clickhouse.query({
      query: `
        SELECT
          bucket,
          error_count,
          total_count,
          if(total_count > 0, error_count / total_count * 100, 0) as error_rate
        FROM mv_error_rate
        WHERE service = {service:String}
          AND bucket >= now() - INTERVAL {hours:UInt32} HOUR
        ORDER BY bucket ASC
      `,
      query_params: { service: service || "", hours: hours || 24 },
      format: "JSONEachRow",
    })
    return result.json()
  })

  // HTTP latency dashboard
  .post("/dashboard/latency", async ({ body }) => {
    const { service, path, hours } = body as any
    const conditions = ["1=1"]
    const params: Record<string, unknown> = { hours: hours || 24 }

    if (service) { conditions.push("service = {service:String}"); params.service = service }
    if (path) { conditions.push("http_path = {path:String}"); params.path = path }

    const result = await clickhouse.query({
      query: `
        SELECT
          bucket,
          quantileMerge(0.5)(p50) as p50_ms,
          quantileMerge(0.95)(p95) as p95_ms,
          quantileMerge(0.99)(p99) as p99_ms,
          request_count,
          avg_ms
        FROM mv_http_latency
        WHERE ${conditions.join(" AND ")}
          AND bucket >= now() - INTERVAL {hours:UInt32} HOUR
        ORDER BY bucket ASC
      `,
      query_params: params,
      format: "JSONEachRow",
    })
    return result.json()
  })

  // Live tail (SSE)
  .get("/events/tail", ({ set }) => {
    set.headers["Content-Type"] = "text/event-stream"
    set.headers["Cache-Control"] = "no-cache"
    set.headers["Connection"] = "keep-alive"

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        // Poll ClickHouse every second for new events
        let lastTs = new Date().toISOString()
        const poll = async () => {
          try {
            const result = await clickhouse.query({
              query: `SELECT * FROM events WHERE timestamp > {lastTs:DateTime64(9)} ORDER BY timestamp ASC LIMIT 100`,
              query_params: { lastTs },
              format: "JSONEachRow",
            })
            const rows: any[] = await result.json()
            for (const row of rows) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(row)}\n\n`))
              lastTs = row.timestamp
            }
          } catch {}
        }

        const interval = setInterval(poll, 1000)

        // Clean up on disconnect
        return () => clearInterval(interval)
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    })
  })

  .listen(PORT)

console.log(`Aires API running at http://localhost:${PORT}`)
console.log(`Swagger UI at http://localhost:${PORT}/api-docs`)
