/**
 * @aires/sdk — TypeScript observability SDK
 *
 * Usage:
 *   import { aires } from "@aires/sdk"
 *
 *   aires.init({ service: "workforce-api", endpoint: "https://collector:4317" })
 *
 *   aires.info("server started", { attr: { port: "4000" } })
 *   aires.error("request failed", { traceId, category: "http", http: { method, path, status } })
 *   aires.span("process-task", { traceId, agentId })
 *   aires.metric("http.latency", 42.5, { tags: ["api"] })
 *
 *   await aires.flush()
 */

// Native bindings (compiled from Rust via NAPI-RS)
// Falls back to pure JS gRPC client if native addon isn't available
let native: any = null

try {
  native = require("../native/aires-sdk-napi.node")
} catch {
  // Native addon not built — will use pure JS fallback
}

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export type LogOptions = {
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

export type InitOptions = {
  service: string
  endpoint: string
  environment?: string
  batchSize?: number
  queueCapacity?: number
  tls?: boolean
  apiKey?: string
}

const toNativeOpts = (opts?: LogOptions) => {
  if (!opts) return undefined
  return {
    trace_id: opts.traceId,
    span_id: opts.spanId,
    session_id: opts.sessionId,
    user_id: opts.userId,
    agent_id: opts.agentId,
    category: opts.category,
    display_text: opts.displayText,
    tags: opts.tags,
    attributes: opts.attr,
    data: opts.data ? Object.fromEntries(
      Object.entries(opts.data).map(([k, v]) => [k, JSON.stringify(v)])
    ) : undefined,
    source_file: opts.file,
    source_line: opts.line,
    source_function: opts.fn,
  }
}

// In-memory buffer for when native addon isn't available
let fallbackBuffer: Array<{ level: string, message: string, opts?: LogOptions, ts: number }> = []
let initialized = false

export const aires = {
  init(opts: InitOptions) {
    if (native) {
      native.init({
        service: opts.service,
        endpoint: opts.endpoint,
        environment: opts.environment,
        batch_size: opts.batchSize,
        queue_capacity: opts.queueCapacity,
        tls: opts.tls,
        api_key: opts.apiKey,
      })
    }
    initialized = true
  },

  trace: (message: string, opts?: LogOptions) => {
    if (native) return native.trace(message, toNativeOpts(opts))
    fallbackBuffer.push({ level: "trace", message, opts, ts: Date.now() })
  },

  debug: (message: string, opts?: LogOptions) => {
    if (native) return native.debug(message, toNativeOpts(opts))
    fallbackBuffer.push({ level: "debug", message, opts, ts: Date.now() })
  },

  info: (message: string, opts?: LogOptions) => {
    if (native) return native.info(message, toNativeOpts(opts))
    fallbackBuffer.push({ level: "info", message, opts, ts: Date.now() })
  },

  warn: (message: string, opts?: LogOptions) => {
    if (native) return native.warn(message, toNativeOpts(opts))
    fallbackBuffer.push({ level: "warn", message, opts, ts: Date.now() })
  },

  error: (message: string, opts?: LogOptions) => {
    if (native) return native.error(message, toNativeOpts(opts))
    fallbackBuffer.push({ level: "error", message, opts, ts: Date.now() })
  },

  fatal: (message: string, opts?: LogOptions) => {
    if (native) return native.fatal(message, toNativeOpts(opts))
    fallbackBuffer.push({ level: "fatal", message, opts, ts: Date.now() })
  },

  span: (name: string, opts?: LogOptions) => {
    if (native) return native.span(name, toNativeOpts(opts))
    fallbackBuffer.push({ level: "span", message: name, opts, ts: Date.now() })
  },

  metric: (name: string, value: number, opts?: LogOptions) => {
    if (native) return native.metric(name, value, toNativeOpts(opts))
    fallbackBuffer.push({ level: "metric", message: `${name}=${value}`, opts, ts: Date.now() })
  },

  flush: async () => {
    if (native) return native.flush()
    // Fallback: dump buffer to stdout as JSON lines
    for (const entry of fallbackBuffer) {
      console.log(JSON.stringify(entry))
    }
    fallbackBuffer = []
  },
}

export default aires
