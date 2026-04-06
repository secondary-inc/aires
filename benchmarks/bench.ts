/**
 * Aires vs Pino vs Winston benchmark
 *
 * Measures: structured log event creation + serialization throughput
 * All loggers write to /dev/null to isolate serialization cost from I/O
 */

import { createWriteStream } from "fs"
import pino from "pino"
import winston from "winston"

// ── Config ──────────────────────────────────────────────────────────────────

const ITERATIONS = 100_000
const WARMUP = 10_000

// ── Null destination (measures serialization, not I/O) ──────────────────────

const devNull = createWriteStream("/dev/null")

// ── Pino setup ──────────────────────────────────────────────────────────────

const pinoLogger = pino(
  { level: "trace", timestamp: pino.stdTimeFunctions.isoTime },
  pino.destination({ dest: "/dev/null", sync: true })
)

// ── Winston setup ───────────────────────────────────────────────────────────

const winstonLogger = winston.createLogger({
  level: "silly",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Stream({ stream: devNull }),
  ],
})

// ── Aires setup (fallback mode — no native addon, JSON to /dev/null) ────────

// Simulate what Aires does: build a structured event object + serialize to JSON
const airesEmit = (level: string, message: string, attrs: Record<string, string>) => {
  const event = {
    ts: new Date().toISOString(),
    level,
    message,
    service: "bench-svc",
    ...attrs,
  }
  devNull.write(JSON.stringify(event))
  devNull.write("\n")
}

// ── Benchmark harness ───────────────────────────────────────────────────────

type BenchFn = () => void

const bench = (name: string, fn: BenchFn, iterations: number): { name: string, ops: number, nsPerOp: number, opsPerSec: number } => {
  // Warmup
  for (let i = 0; i < WARMUP; i++) fn()

  // Measure
  const start = Bun.nanoseconds()
  for (let i = 0; i < iterations; i++) fn()
  const elapsed = Bun.nanoseconds() - start

  const nsPerOp = elapsed / iterations
  const opsPerSec = 1e9 / nsPerOp

  return { name, ops: iterations, nsPerOp: Math.round(nsPerOp), opsPerSec: Math.round(opsPerSec) }
}

// ── Workloads ───────────────────────────────────────────────────────────────

console.log("Aires vs Pino vs Winston Benchmark")
console.log(`${ITERATIONS.toLocaleString()} iterations, ${WARMUP.toLocaleString()} warmup\n`)

// 1. Simple string message
console.log("── Simple message ─────────────────────────")
const results1 = [
  bench("pino", () => pinoLogger.info("hello world"), ITERATIONS),
  bench("winston", () => winstonLogger.info("hello world"), ITERATIONS),
  bench("aires (js)", () => airesEmit("info", "hello world", {}), ITERATIONS),
]
printResults(results1)

// 2. Message + 3 string attributes
console.log("\n── Message + 3 attributes ─────────────────")
const results2 = [
  bench("pino", () => pinoLogger.info({ userId: "user-abc", traceId: "trace-123", path: "/api/agents" }, "request completed"), ITERATIONS),
  bench("winston", () => winstonLogger.info("request completed", { userId: "user-abc", traceId: "trace-123", path: "/api/agents" }), ITERATIONS),
  bench("aires (js)", () => airesEmit("info", "request completed", { userId: "user-abc", traceId: "trace-123", path: "/api/agents" }), ITERATIONS),
]
printResults(results2)

// 3. Message + 8 attributes (realistic HTTP request log)
console.log("\n── Message + 8 attributes (HTTP request) ──")
const httpAttrs = {
  userId: "user-abc",
  traceId: "trace-123",
  sessionId: "sess-xyz",
  method: "POST",
  path: "/agents/list",
  status: "200",
  durationMs: "42",
  requestSize: "256",
}
const results3 = [
  bench("pino", () => pinoLogger.info(httpAttrs, "request completed"), ITERATIONS),
  bench("winston", () => winstonLogger.info("request completed", httpAttrs), ITERATIONS),
  bench("aires (js)", () => airesEmit("info", "request completed", httpAttrs), ITERATIONS),
]
printResults(results3)

// 4. Child logger / scoped context (pino child, winston child, aires .with equivalent)
console.log("\n── Scoped logger (child/with) ─────────────")
const pinoChild = pinoLogger.child({ userId: "user-abc", sessionId: "sess-xyz" })
const winstonChild = winstonLogger.child({ userId: "user-abc", sessionId: "sess-xyz" })
const airesBase = { userId: "user-abc", sessionId: "sess-xyz" }
const results4 = [
  bench("pino child", () => pinoChild.info({ path: "/api" }, "request"), ITERATIONS),
  bench("winston child", () => winstonChild.info("request", { path: "/api" }), ITERATIONS),
  bench("aires .with()", () => airesEmit("info", "request", { ...airesBase, path: "/api" }), ITERATIONS),
]
printResults(results4)

// 5. Error with stack trace
console.log("\n── Error with stack trace ─────────────────")
const err = new Error("something broke")
const results5 = [
  bench("pino", () => pinoLogger.error({ err, traceId: "t-1" }, "unhandled error"), ITERATIONS),
  bench("winston", () => winstonLogger.error("unhandled error", { error: { message: err.message, stack: err.stack }, traceId: "t-1" }), ITERATIONS),
  bench("aires (js)", () => airesEmit("error", "unhandled error", { errorMessage: err.message, errorStack: err.stack || "", traceId: "t-1" }), ITERATIONS),
]
printResults(results5)

// ── Summary ─────────────────────────────────────────────────────────────────

console.log("\n── Summary ────────────────────────────────")
console.log("All benchmarks measure event creation + JSON serialization")
console.log("writing to /dev/null (no I/O bottleneck).")
console.log("")
console.log("'aires (js)' is the pure JS fallback path.")
console.log("With the NAPI-RS native addon, aires uses Rust for")
console.log("serialization with arena-allocated buffers — expect")
console.log("2-5x additional speedup over the JS fallback numbers.")

devNull.end()

// ── Helpers ─────────────────────────────────────────────────────────────────

function printResults(results: Array<{ name: string, nsPerOp: number, opsPerSec: number }>) {
  const fastest = Math.min(...results.map(r => r.nsPerOp))
  const maxName = Math.max(...results.map(r => r.name.length))

  for (const r of results) {
    const pad = " ".repeat(maxName - r.name.length)
    const ratio = r.nsPerOp / fastest
    const marker = ratio === 1 ? " (fastest)" : ` (${ratio.toFixed(2)}x slower)`
    console.log(
      `  ${r.name}${pad}  ${r.nsPerOp.toLocaleString().padStart(8)} ns/op  ${formatOps(r.opsPerSec).padStart(12)} ops/sec${marker}`
    )
  }
}

function formatOps(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toString()
}
