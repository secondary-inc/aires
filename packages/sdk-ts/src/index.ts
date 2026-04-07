import { AsyncLocalStorage } from "node:async_hooks"

// ── Types ───────────────────────────────────────────────────────────────────

type Attrs = Record<string, unknown>

type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

type SpanHandle = {
  end: () => void
  log: Logger
}

// ── Promoted fields ─────────────────────────────────────────────────────────
// These keys get extracted from attrs and placed into dedicated proto fields
// for ClickHouse indexing. Everything else stays in the attr map.

const PROMOTED = new Set([
  "traceId", "spanId", "parentSpanId", "subtraceId",
  "sessionId", "userId",
])

const HTTP_FIELDS = new Set([
  "method", "path", "status", "durationMs",
  "requestSize", "responseSize", "userAgent", "remoteAddr",
])

const ERROR_FIELDS = new Set(["type", "message", "stack", "handled"])

// ── Event Buffer ────────────────────────────────────────────────────────────

type RawEvent = {
  level: Level
  message: string
  attrs: Attrs
  ts: number
  file?: string
  line?: number
}

let _buffer: RawEvent[] = []
let _emitter: ((event: RawEvent) => void) | null = null
let _service = ""
let _environment = ""

const emit = (event: RawEvent) => {
  if (_emitter) {
    _emitter(event)
  } else {
    _buffer.push(event)
  }
}

// ── Scope (AsyncLocalStorage) ───────────────────────────────────────────────

const _store = new AsyncLocalStorage<Attrs>()

const currentScope = (): Attrs => _store.getStore() || {}

// ── Source Location ─────────────────────────────────────────────────────────

const captureSource = (): { file?: string, line?: number } => {
  const obj: any = {}
  Error.captureStackTrace(obj, captureSource)
  const frame = obj.stack?.split("\n")[2]
  if (!frame) return {}
  const match = frame.match(/(?:at\s+)?(?:.*?\s+\()?(.+?):(\d+):\d+\)?/)
  if (!match) return {}
  return { file: match[1], line: parseInt(match[2]) }
}

// ── Logger ──────────────────────────────────────────────────────────────────

type Logger = {
  (message: string, attrs?: Attrs): void

  trace: (message: string, attrs?: Attrs) => void
  debug: (message: string, attrs?: Attrs) => void
  info: (message: string, attrs?: Attrs) => void
  warn: (message: string, attrs?: Attrs) => void
  error: (message: string, attrs?: Attrs) => void
  fatal: (message: string, attrs?: Attrs) => void

  with: (attrs: Attrs) => Logger
  scope: <T>(attrs: Attrs, fn: () => T | Promise<T>) => T | Promise<T>
  span: (name: string, attrs?: Attrs) => SpanHandle
  metric: (name: string, value: number, attrs?: Attrs) => void
}

const createLogger = (base: Attrs = {}): Logger => {
  const resolve = (extra?: Attrs): Attrs => ({
    ...currentScope(),
    ...base,
    ...extra,
  })

  const emitLog = (level: Level, message: string, extra?: Attrs) => {
    const source = captureSource()
    emit({
      level,
      message,
      attrs: resolve(extra),
      ts: Date.now(),
      ...source,
    })
  }

  const logger: any = (message: string, attrs?: Attrs) => emitLog("info", message, attrs)

  logger.trace = (message: string, attrs?: Attrs) => emitLog("trace", message, attrs)
  logger.debug = (message: string, attrs?: Attrs) => emitLog("debug", message, attrs)
  logger.info = (message: string, attrs?: Attrs) => emitLog("info", message, attrs)
  logger.warn = (message: string, attrs?: Attrs) => emitLog("warn", message, attrs)
  logger.error = (message: string, attrs?: Attrs) => emitLog("error", message, attrs)
  logger.fatal = (message: string, attrs?: Attrs) => emitLog("fatal", message, attrs)

  logger.with = (attrs: Attrs): Logger => createLogger({ ...base, ...attrs })

  logger.scope = <T>(attrs: Attrs, fn: () => T | Promise<T>): T | Promise<T> =>
    _store.run({ ...currentScope(), ...base, ...attrs }, fn)

  logger.span = (name: string, attrs?: Attrs): SpanHandle => {
    const spanId = crypto.randomUUID()
    const start = performance.now()
    const merged = { ...base, ...attrs, spanId }

    emitLog("info", `span:start ${name}`, { ...merged, _span: "start", _spanName: name })

    return {
      end: () => {
        const durationMs = Math.round(performance.now() - start)
        emitLog("info", `span:end ${name}`, {
          ...merged,
          _span: "end",
          _spanName: name,
          durationMs: String(durationMs),
        })
      },
      log: createLogger(merged),
    }
  }

  logger.metric = (name: string, value: number, attrs?: Attrs) => {
    // When native addon is available, use its dedicated metric path
    // which properly fills the proto MetricValue field
    if (_native) {
      const merged = resolve(attrs)
      const promoted: any = {}
      const attr: Record<string, string> = {}

      for (const [k, v] of Object.entries(merged)) {
        if (PROMOTED.has(k)) {
          promoted[k] = String(v)
        } else if (k !== "_metric" && k !== "_metricValue" && v !== undefined && v !== null) {
          attr[k] = typeof v === "string" ? v : JSON.stringify(v)
        }
      }

      _native.metric(name, value, {
        trace_id: promoted.traceId,
        span_id: promoted.spanId,
        session_id: promoted.sessionId,
        user_id: promoted.userId,
        attributes: attr,
      })
      return
    }

    // Fallback: emit as regular log event
    emit({
      level: "info",
      message: name,
      attrs: { ...resolve(attrs), _metric: name, _metricValue: String(value) },
      ts: Date.now(),
    })
  }

  return logger as Logger
}

// ── Global Logger ───────────────────────────────────────────────────────────

export const log: Logger = createLogger()

// ── Init + Console Patching ─────────────────────────────────────────────────

type InitOptions = {
  service: string
  endpoint: string
  environment?: string
  batchSize?: number
  queueCapacity?: number
  tls?: boolean
  apiKey?: string
}

let _native: any = null

export const aires = {
  init(opts: InitOptions) {
    _service = opts.service
    _environment = opts.environment || "production"

    // Try native addon
    try {
      _native = require("../native/aires-sdk-napi.node")
      _native.init({
        service: opts.service,
        endpoint: opts.endpoint,
        environment: opts.environment,
        batch_size: opts.batchSize,
        queue_capacity: opts.queueCapacity,
        tls: opts.tls,
        api_key: opts.apiKey,
      })
    } catch {
      // Native not available — use fallback
    }

    // Set up emitter
    _emitter = (event) => {
      if (_native) {
        const promoted: any = {}
        const attr: Record<string, string> = {}

        let category: string | undefined
        let kind: string | undefined
        let agentId: string | undefined

        for (const [k, v] of Object.entries(event.attrs)) {
          if (PROMOTED.has(k)) {
            promoted[k] = String(v)
          } else if (k === "_category") {
            category = String(v)
          } else if (k === "kind") {
            kind = String(v)
          } else if (k === "agentId") {
            agentId = String(v)
            attr[k] = String(v)
          } else if (v !== undefined && v !== null) {
            attr[k] = typeof v === "string" ? v : JSON.stringify(v)
          }
        }

        const nativeOpts: any = {
          trace_id: promoted.traceId,
          span_id: promoted.spanId,
          session_id: promoted.sessionId,
          user_id: promoted.userId,
          agent_id: agentId,
          category,
          kind,
          attributes: attr,
          source_file: event.file,
          source_line: event.line,
        }

        switch (event.level) {
          case "trace": _native.trace(event.message, nativeOpts); break
          case "debug": _native.debug(event.message, nativeOpts); break
          case "info": _native.info(event.message, nativeOpts); break
          case "warn": _native.warn(event.message, nativeOpts); break
          case "error": _native.error(event.message, nativeOpts); break
          case "fatal": _native.fatal(event.message, nativeOpts); break
        }
      } else {
        // Fallback: structured JSON to stdout
        const { level, message, attrs, ts, file, line } = event
        const out: any = { ts: new Date(ts).toISOString(), level, message, service: _service }
        if (file) out.file = `${file}:${line}`
        const attrKeys = Object.keys(attrs)
        if (attrKeys.length > 0) out.attrs = attrs
        process.stdout.write(JSON.stringify(out) + "\n")
      }
    }

    // Flush buffered events
    for (const event of _buffer) {
      _emitter(event)
    }
    _buffer = []
  },

  patchConsole() {
    const original = {
      log: console.log,
      debug: console.debug,
      info: console.info,
      warn: console.warn,
      error: console.error,
    }

    console.log = (...args: unknown[]) => {
      const message = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
      log.info(message, { _source: "console.log" })
      original.log.apply(console, args)
    }

    console.debug = (...args: unknown[]) => {
      const message = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
      log.debug(message, { _source: "console.debug" })
      original.debug.apply(console, args)
    }

    console.info = (...args: unknown[]) => {
      const message = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
      log.info(message, { _source: "console.info" })
      original.info.apply(console, args)
    }

    console.warn = (...args: unknown[]) => {
      const message = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
      log.warn(message, { _source: "console.warn" })
      original.warn.apply(console, args)
    }

    console.error = (...args: unknown[]) => {
      const message = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
      log.error(message, { _source: "console.error" })
      original.error.apply(console, args)
    }
  },

  async flush() {
    if (_native) await _native.flush()
  },
}

// ── Elysia Plugin ───────────────────────────────────────────────────────────

type PluginOptions = {
  /** Auto-log request/response (default: true) */
  logRequests?: boolean
  /** Header to extract trace ID from (default: x-trace-id) */
  traceHeader?: string
  /** Header to extract session ID from (default: x-session-id) */
  sessionHeader?: string
}

export const airesPlugin = (opts?: PluginOptions) => {
  const logRequests = opts?.logRequests !== false
  const traceHeader = opts?.traceHeader || "x-trace-id"
  const sessionHeader = opts?.sessionHeader || "x-session-id"

  return (app: any) => {
    app.onRequest(({ request, store }: any) => {
      const traceId = request.headers.get(traceHeader) || crypto.randomUUID()
      const sessionId = request.headers.get(sessionHeader) || ""
      const start = performance.now()

      store._aires = { traceId, sessionId, start }
    })

    app.onBeforeHandle(({ request, store }: any) => {
      const { traceId, sessionId } = store._aires || {}
      // Run the handler inside an AsyncLocalStorage scope
      // so all log() calls inherit the trace context
      return _store.run(
        { traceId, sessionId, ...(store._aires?.extra || {}) },
        () => undefined,
      )
    })

    // Wrap each handler to run inside the scope
    app.derive(({ request, store }: any) => {
      const { traceId, sessionId } = store._aires || {}

      return {
        get log() {
          return createLogger({ traceId, sessionId })
        },
      }
    })

    if (logRequests) {
      app.onAfterHandle(({ request, set, store }: any) => {
        const { traceId, sessionId, start } = store._aires || {}
        const durationMs = Math.round(performance.now() - start)
        const url = new URL(request.url)

        log.info("request", {
          traceId,
          sessionId,
          method: request.method,
          path: url.pathname,
          status: String(set.status || 200),
          durationMs: String(durationMs),
          _category: "http",
        })
      })

      app.onError(({ request, error, set, store }: any) => {
        const { traceId, sessionId, start } = store._aires || {}
        const durationMs = Math.round(performance.now() - start)
        const url = new URL(request.url)

        log.error("request failed", {
          traceId,
          sessionId,
          method: request.method,
          path: url.pathname,
          status: String(set.status || 500),
          durationMs: String(durationMs),
          errorType: error?.constructor?.name,
          errorMessage: error?.message,
          _category: "http",
        })
      })
    }

    return app
  }
}

// ── Convenience re-exports ──────────────────────────────────────────────────

export { log as default }
export type { Attrs, Level, Logger, SpanHandle, InitOptions, PluginOptions }
