#!/usr/bin/env bun
/**
 * aires-dev — Development launcher with fullscreen TUI
 *
 * Replaces `concurrently` by spawning child processes and capturing
 * ALL their output into the Aires TUI. Owns the terminal directly
 * so keyboard navigation, filtering, and expansion all work.
 *
 * Usage:
 *   aires-dev "bun run dev:api" "bun run dev:app" "bun run dev:axiom"
 *   aires-dev --names api,app,axiom "cmd1" "cmd2" "cmd3"
 *
 * Or from package.json:
 *   "dev": "aires-dev --names api,app,axiom 'cd api && bun run --watch src/server.ts' 'cd app && bun run rsbuild dev' 'cd ../ontology && bun run --watch src/server.ts'"
 */

import { spawn, type ChildProcess } from "node:child_process"

// ── ANSI ────────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GOLD = "\x1b[33m"
const INVERSE = "\x1b[7m"

const SEVERITY_COLORS: Record<string, string> = {
  trace: "\x1b[90m",
  debug: "\x1b[35m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[41m\x1b[37m",
  stdout: "\x1b[90m",
  stderr: "\x1b[91m",
}

const PROCESS_COLORS = [
  "\x1b[34m", // blue
  "\x1b[32m", // green
  "\x1b[35m", // magenta
  "\x1b[36m", // cyan
  "\x1b[33m", // yellow
  "\x1b[91m", // bright red
]

const SEVERITY_ORDER = ["trace", "debug", "info", "warn", "error", "fatal", "stdout", "stderr"]

// ── Types ───────────────────────────────────────────────────────────────────

interface TuiEvent {
  id: number
  ts: number
  level: string
  message: string
  attrs: Record<string, unknown>
  category: string
  source: string // process name (api, app, etc.)
  expanded: boolean
}

// ── State ───────────────────────────────────────────────────────────────────

const MAX_EVENTS = 10000

const state = {
  events: [] as TuiEvent[],
  filteredIndices: [] as number[],
  selectedIdx: -1,
  severityFilter: new Set(SEVERITY_ORDER),
  categoryFilter: null as string | null,
  sourceFilter: null as string | null,
  searchQuery: "",
  searchMode: false,
  paused: false,
  eventsPerSec: 0,
  processNames: [] as string[],
  children: [] as ChildProcess[],
}

let eventCounter = 0
let recentCount = 0
let renderTimeout: ReturnType<typeof setTimeout> | null = null
const categories = new Set<string>()

// ── Parse Args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
let names: string[] = []
const commands: string[] = []

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--names" || args[i] === "-n") {
    names = (args[++i] || "").split(",").map(s => s.trim())
  } else if (!args[i].startsWith("-")) {
    commands.push(args[i])
  }
}

if (commands.length === 0) {
  console.error("Usage: aires-dev [--names api,app] 'command1' 'command2' ...")
  process.exit(1)
}

// Auto-name if not provided
if (names.length === 0) {
  names = commands.map((_, i) => `p${i}`)
}

state.processNames = names

// ── Event Ingestion ─────────────────────────────────────────────────────────

function pushEvent(
  source: string,
  level: string,
  message: string,
  attrs: Record<string, unknown> = {},
  category = "",
) {
  const ev: TuiEvent = {
    id: eventCounter++,
    ts: Date.now(),
    level,
    message,
    attrs,
    category,
    source,
    expanded: false,
  }

  if (category) categories.add(category)

  state.events.push(ev)
  recentCount++

  if (state.events.length > MAX_EVENTS) {
    state.events = state.events.slice(-MAX_EVENTS)
  }

  recomputeFiltered()

  if (!state.paused) {
    state.selectedIdx = state.filteredIndices.length - 1
  }

  scheduleRender()
}

function handleLine(source: string, line: string, isStderr: boolean) {
  const trimmed = line.trim()
  if (!trimmed) return

  // Try to parse as Aires structured JSON
  if (trimmed.startsWith("{\"ts\":")) {
    try {
      const parsed = JSON.parse(trimmed)
      const category = parsed.attrs?._category || parsed.attrs?._source || ""
      const level = parsed.level || "info"

      // Skip metric spam
      if (parsed.attrs?._metric) return

      pushEvent(source, level, parsed.message || trimmed, parsed.attrs || {}, category)
      return
    } catch {
      // Not valid JSON — fall through to raw handling
    }
  }

  // Raw output — capture as stdout/stderr event
  pushEvent(source, isStderr ? "stderr" : "stdout", trimmed)
}

// ── Filtering ───────────────────────────────────────────────────────────────

function recomputeFiltered() {
  const { events, severityFilter, categoryFilter, sourceFilter, searchQuery } = state
  const query = searchQuery.toLowerCase()

  state.filteredIndices = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (!severityFilter.has(e.level)) continue
    if (categoryFilter && e.category !== categoryFilter) continue
    if (sourceFilter && e.source !== sourceFilter) continue
    if (query && !e.message.toLowerCase().includes(query) && !e.source.toLowerCase().includes(query)) continue
    state.filteredIndices.push(i)
  }
}

// ── Child Process Management ────────────────────────────────────────────────

function spawnChildren() {
  for (let i = 0; i < commands.length; i++) {
    const name = names[i] || `p${i}`
    const cmd = commands[i]

    const child = spawn("sh", ["-c", cmd], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1", AIRES_TUI: "0" },
      cwd: process.cwd(),
    })

    child.stdout!.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n")
      for (const line of lines) handleLine(name, line, false)
    })

    child.stderr!.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n")
      for (const line of lines) handleLine(name, line, true)
    })

    child.on("exit", (code) => {
      pushEvent(name, code === 0 ? "info" : "error", `Process "${name}" exited with code ${code}`)
    })

    state.children.push(child)
  }
}

// ── Terminal Setup ──────────────────────────────────────────────────────────

function setupTerminal() {
  process.stdout.write("\x1b[?25l")   // hide cursor
  process.stdout.write("\x1b[?1049h") // alt screen buffer

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on("data", handleKeypress)
  }
}

function teardownTerminal() {
  process.stdout.write("\x1b[?1049l") // restore screen
  process.stdout.write("\x1b[?25h")   // show cursor

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
}

function cleanup() {
  teardownTerminal()
  for (const child of state.children) {
    try { child.kill("SIGTERM") } catch {}
  }
  process.exit(0)
}

// ── Input ───────────────────────────────────────────────────────────────────

function handleKeypress(data: Buffer) {
  const key = data.toString()
  const code = data[0]

  // Search mode
  if (state.searchMode) {
    if (key === "\x1b" || key === "\r") {
      state.searchMode = false
      recomputeFiltered()
      scheduleRender()
      return
    }
    if (code === 127 || code === 8) {
      state.searchQuery = state.searchQuery.slice(0, -1)
      recomputeFiltered()
      scheduleRender()
      return
    }
    if (code >= 32 && code < 127) {
      state.searchQuery += key
      recomputeFiltered()
      scheduleRender()
      return
    }
    return
  }

  // Quit
  if (key === "q" || key === "\x03") {
    cleanup()
    return
  }

  // Navigation
  if (key === "\x1b[A" || key === "k") {
    if (state.selectedIdx > 0) {
      state.selectedIdx--
      state.paused = true
    }
    scheduleRender()
    return
  }
  if (key === "\x1b[B" || key === "j") {
    if (state.selectedIdx < state.filteredIndices.length - 1) {
      state.selectedIdx++
    }
    if (state.selectedIdx === state.filteredIndices.length - 1) {
      state.paused = false
    }
    scheduleRender()
    return
  }

  // Expand
  if (key === "\r" || key === " ") {
    const idx = state.filteredIndices[state.selectedIdx]
    if (idx !== undefined && state.events[idx]) {
      state.events[idx].expanded = !state.events[idx].expanded
    }
    scheduleRender()
    return
  }

  // Search
  if (key === "/") {
    state.searchMode = true
    state.searchQuery = ""
    scheduleRender()
    return
  }

  // Escape — clear filters
  if (key === "\x1b") {
    state.searchQuery = ""
    state.categoryFilter = null
    state.sourceFilter = null
    state.severityFilter = new Set(SEVERITY_ORDER)
    recomputeFiltered()
    scheduleRender()
    return
  }

  // Severity cycle
  if (key === "f") {
    const s = state.severityFilter
    if (s.size === SEVERITY_ORDER.length) {
      state.severityFilter = new Set(["warn", "error", "fatal", "stdout", "stderr"])
    } else if (s.has("warn") && !s.has("info")) {
      state.severityFilter = new Set(["error", "fatal", "stderr"])
    } else {
      state.severityFilter = new Set(SEVERITY_ORDER)
    }
    recomputeFiltered()
    scheduleRender()
    return
  }

  // Tab — cycle source filter (process name)
  if (key === "\t") {
    const sources = [null, ...state.processNames]
    const curIdx = sources.indexOf(state.sourceFilter)
    state.sourceFilter = sources[(curIdx + 1) % sources.length]
    recomputeFiltered()
    scheduleRender()
    return
  }

  // Shift+Tab or S — cycle category filter
  if (key === "s" || key === "\x1b[Z") {
    const cats = [null, ...Array.from(categories).sort()]
    const curIdx = cats.indexOf(state.categoryFilter)
    state.categoryFilter = cats[(curIdx + 1) % cats.length]
    recomputeFiltered()
    scheduleRender()
    return
  }

  // Clear
  if (key === "c") {
    state.events = []
    state.filteredIndices = []
    state.selectedIdx = -1
    eventCounter = 0
    scheduleRender()
    return
  }

  // Pause
  if (key === "p") {
    state.paused = !state.paused
    if (!state.paused) {
      state.selectedIdx = state.filteredIndices.length - 1
    }
    scheduleRender()
    return
  }

  // Jump
  if (key === "G") {
    state.selectedIdx = state.filteredIndices.length - 1
    state.paused = false
    scheduleRender()
    return
  }
  if (key === "g") {
    state.selectedIdx = 0
    state.paused = true
    scheduleRender()
    return
  }

  // Number keys 1-6: toggle severity
  const num = parseInt(key)
  if (num >= 1 && num <= 6) {
    const level = SEVERITY_ORDER[num - 1]
    if (state.severityFilter.has(level)) {
      state.severityFilter.delete(level)
    } else {
      state.severityFilter.add(level)
    }
    recomputeFiltered()
    scheduleRender()
    return
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function scheduleRender() {
  if (renderTimeout) return
  renderTimeout = setTimeout(() => {
    renderTimeout = null
    render()
  }, 16)
}

function render() {
  const cols = process.stdout.columns || 120
  const rows = process.stdout.rows || 40
  const lines: string[] = []

  // ── Header ────────────────────────────────────────────────────
  const processIndicators = state.processNames.map((name, i) => {
    const color = PROCESS_COLORS[i % PROCESS_COLORS.length]
    const active = !state.sourceFilter || state.sourceFilter === name
    return `${active ? color + BOLD : DIM}${name}${RESET}`
  }).join(" ")

  const pauseBadge = state.paused ? ` ${GOLD}${BOLD}⏸ PAUSED${RESET}` : ""
  lines.push(` ${GOLD}${BOLD}▓ Aires${RESET} ${processIndicators}${DIM} · ${state.events.length} events · ${state.eventsPerSec}/s${RESET}${pauseBadge}`)

  // ── Filter bar ────────────────────────────────────────────────
  const sevLabels = SEVERITY_ORDER.slice(0, 6).map(s => {
    const active = state.severityFilter.has(s)
    const color = active ? (SEVERITY_COLORS[s] || "") : "\x1b[90m"
    return `${color}${active ? BOLD : ""}${s.slice(0, 3).toUpperCase()}${RESET}`
  })
  const parts = [sevLabels.join(" ")]

  if (state.sourceFilter) {
    parts.push(`${DIM}src:${RESET}${GOLD}${state.sourceFilter}${RESET}`)
  }
  if (state.categoryFilter) {
    parts.push(`${DIM}cat:${RESET}${GOLD}${state.categoryFilter}${RESET}`)
  }
  if (state.searchMode) {
    parts.push(`${GOLD}/${RESET}${state.searchQuery}${GOLD}▌${RESET}`)
  } else if (state.searchQuery) {
    parts.push(`${DIM}search:${RESET}${state.searchQuery}`)
  }

  lines.push(` ${parts.join(`${DIM} │ ${RESET}`)}`)

  // ── Separator ─────────────────────────────────────────────────
  lines.push(`${DIM}${"─".repeat(cols)}${RESET}`)

  // ── Events ────────────────────────────────────────────────────
  const headerHeight = lines.length
  const footerHeight = 1
  const availableRows = rows - headerHeight - footerHeight

  // Build visible event lines
  const eventLines: Array<{ filtIdx: number, lines: string[] }> = []
  for (const fIdx of state.filteredIndices) {
    const e = state.events[fIdx]
    eventLines.push({ filtIdx: fIdx, lines: formatEvent(e, cols) })
  }

  const lineCounts = eventLines.map(el => el.lines.length)

  // Scroll so selected is visible
  let startEvent = 0
  if (state.selectedIdx >= 0) {
    let linesBefore = 0
    for (let i = 0; i < state.selectedIdx && i < lineCounts.length; i++) {
      linesBefore += lineCounts[i]
    }
    const half = Math.floor(availableRows / 2)
    let accum = 0
    for (let i = 0; i < eventLines.length; i++) {
      if (accum >= Math.max(0, linesBefore - half)) {
        startEvent = i
        break
      }
      accum += lineCounts[i]
    }
  }

  // Render visible events
  let rendered = 0
  for (let i = startEvent; i < eventLines.length && rendered < availableRows; i++) {
    const el = eventLines[i]
    const isSelected = (i === state.selectedIdx)

    for (const line of el.lines) {
      if (rendered >= availableRows) break
      lines.push(isSelected ? `${INVERSE}${line}${RESET}` : line)
      rendered++
    }
  }

  // Fill remaining
  while (rendered < availableRows) {
    lines.push("")
    rendered++
  }

  // ── Footer ────────────────────────────────────────────────────
  const footerItems = [
    `${DIM}↑↓${RESET} nav`,
    `${DIM}⏎${RESET} expand`,
    `${DIM}f${RESET} severity`,
    `${DIM}/${RESET} search`,
    `${DIM}⇥${RESET} source`,
    `${DIM}s${RESET} category`,
    `${DIM}p${RESET} pause`,
    `${DIM}c${RESET} clear`,
    `${DIM}q${RESET} quit`,
  ]
  const footerRight = `${DIM}${state.filteredIndices.length}/${state.events.length}${RESET}`
  lines.push(` ${footerItems.join("  ")}  ${footerRight}`)

  // ── Write ─────────────────────────────────────────────────────
  let output = "\x1b[H"
  for (let i = 0; i < lines.length && i < rows; i++) {
    output += lines[i] + "\x1b[K\n"
  }
  process.stdout.write(output)
}

function formatEvent(e: TuiEvent, cols: number): string[] {
  const result: string[] = []

  const d = new Date(e.ts)
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`

  const sevColor = SEVERITY_COLORS[e.level] || ""
  const sevLabel = e.level === "stdout" ? "···"
    : e.level === "stderr" ? "ERR"
    : e.level.slice(0, 3).toUpperCase()

  const srcColor = PROCESS_COLORS[state.processNames.indexOf(e.source) % PROCESS_COLORS.length] || DIM
  const srcLabel = e.source ? e.source.slice(0, 5) : ""

  const cat = e.category ? `[${e.category}]` : ""

  const prefixLen = 12 + 1 + 5 + 1 + 5 + 1 + 10 + 2
  const msgSpace = cols - prefixLen
  const msg = e.message.length > msgSpace && !e.expanded
    ? e.message.slice(0, msgSpace - 1) + "…"
    : e.message

  let msgColor = ""
  if (e.level === "error" || e.level === "fatal") msgColor = SEVERITY_COLORS[e.level]
  else if (e.level === "warn") msgColor = SEVERITY_COLORS.warn
  else if (e.level === "stdout" || e.level === "stderr") msgColor = DIM

  const prefix = ` ${DIM}${time}${RESET} ${sevColor}${BOLD}${pr(sevLabel, 5)}${RESET} ${srcColor}${pr(srcLabel, 5)}${RESET} ${DIM}${pr(cat, 10)}${RESET} `
  result.push(`${prefix}${msgColor}${msg}${RESET}`)

  if (e.expanded) {
    const indent = "                                      "
    const attrs = e.attrs || {}

    // Public attrs
    for (const [key, val] of Object.entries(attrs)) {
      if (key.startsWith("_")) continue
      const valStr = typeof val === "string" ? val : JSON.stringify(val)
      result.push(`${indent}${DIM}${key}:${RESET} ${valStr}`)
    }

    // Internal attrs
    for (const [key, val] of Object.entries(attrs)) {
      if (!key.startsWith("_")) continue
      const valStr = typeof val === "string" ? val : JSON.stringify(val)
      result.push(`${indent}${DIM}${key}: ${valStr}${RESET}`)
    }

    result.push("")
  }

  return result
}

function p2(n: number): string { return n < 10 ? `0${n}` : `${n}` }
function p3(n: number): string { return n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}` }
function pr(s: string, len: number): string { return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length) }

// ── Main ────────────────────────────────────────────────────────────────────

process.on("SIGINT", cleanup)
process.on("SIGTERM", cleanup)

setupTerminal()

// Rate counter
setInterval(() => {
  state.eventsPerSec = recentCount
  recentCount = 0
  scheduleRender()
}, 1000)

spawnChildren()
scheduleRender()

pushEvent("aires", "info", `Launched ${commands.length} process(es): ${names.join(", ")}`)
