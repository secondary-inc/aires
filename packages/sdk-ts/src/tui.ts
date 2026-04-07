/**
 * Aires TUI — Terminal UI for real-time log viewing
 *
 * A fullscreen terminal interface that captures all Aires events and raw
 * stdout/stderr output, providing filtering, expansion, pretty formatting,
 * and keyboard navigation.
 *
 * Activated via aires.init({ tui: true }) or AIRES_TUI=1 env var.
 *
 * Layout:
 * ┌─────────────────────────────────────────────────────────────┐
 * │  ▓ Aires · workforce · 342 events · 12/s                   │  ← header
 * │  Filter: error,warn  │  Search: database                   │  ← filter bar
 * ├─────────────────────────────────────────────────────────────┤
 * │  12:34:05.123 INFO  [http]  request POST /agents/list 4ms  │  ← events
 * │  12:34:05.456 DEBUG [db]    Agent.findMany 2ms 5 rows      │
 * │ ▶12:34:05.789 ERROR [llm]   llm.generate failed            │  ← expanded
 * │    modelId: claude-haiku-4.5                                │
 * │    errorType: ThrottlingException                           │
 * │    errorMessage: Rate limit exceeded                        │
 * │  12:34:06.012 INFO  [agent] triage complete: 3 event(s)    │
 * │  12:34:06.345 ···   [stdout] Server listening on :4000     │  ← raw stdout
 * ├─────────────────────────────────────────────────────────────┤
 * │  ↑/↓ navigate  ENTER expand  f filter  / search  q quit   │  ← footer
 * └─────────────────────────────────────────────────────────────┘
 *
 * Keys:
 *   ↑/↓ or j/k    Navigate events
 *   Enter/Space    Toggle expand/collapse selected event
 *   f              Cycle severity filter (all → error,warn → error → all)
 *   /              Focus search input
 *   Escape         Clear search / exit filter mode
 *   c              Clear all events
 *   p              Pause/Resume auto-scroll
 *   q              Quit TUI (reverts to normal output)
 *   1-6            Toggle severity levels (1=trace 2=debug 3=info 4=warn 5=error 6=fatal)
 *   Tab            Cycle category filter
 */

import type { Attrs, Level } from "./index"

// ── Types ───────────────────────────────────────────────────────────────────

interface TuiEvent {
  id: number
  ts: number
  level: Level | "stdout" | "stderr"
  message: string
  attrs: Attrs
  category: string
  file?: string
  line?: number
  expanded: boolean
}

interface TuiState {
  events: TuiEvent[]
  filteredIndices: number[]
  selectedIdx: number
  severityFilter: Set<string>
  categoryFilter: string | null
  searchQuery: string
  searchMode: boolean
  paused: boolean
  eventsPerSec: number
  service: string
  running: boolean
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_EVENTS = 5000
const SEVERITY_COLORS: Record<string, string> = {
  trace:  "\x1b[90m",      // gray
  debug:  "\x1b[35m",      // magenta
  info:   "\x1b[36m",      // cyan
  warn:   "\x1b[33m",      // yellow
  error:  "\x1b[31m",      // red
  fatal:  "\x1b[41m\x1b[37m", // white on red bg
  stdout: "\x1b[90m",      // gray
  stderr: "\x1b[91m",      // bright red
}
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GOLD = "\x1b[33m"
const INVERSE = "\x1b[7m"

const SEVERITY_ORDER: string[] = ["trace", "debug", "info", "warn", "error", "fatal", "stdout", "stderr"]

// ── State ───────────────────────────────────────────────────────────────────

let _state: TuiState | null = null
let _eventCounter = 0
let _recentCount = 0
let _rateInterval: ReturnType<typeof setInterval> | null = null
let _renderTimeout: ReturnType<typeof setTimeout> | null = null
let _origStdoutWrite: Function | null = null
let _origStderrWrite: Function | null = null
let _origConsole: Record<string, Function> = {}
let _categories = new Set<string>()

// ── Public API ──────────────────────────────────────────────────────────────

export function startTui(service: string): {
  pushEvent: (event: { level: Level, message: string, attrs: Attrs, ts: number, file?: string, line?: number }) => void
  stop: () => void
} {
  if (_state) return { pushEvent: pushEvent, stop: stopTui }

  _state = {
    events: [],
    filteredIndices: [],
    selectedIdx: -1,
    severityFilter: new Set(SEVERITY_ORDER),
    categoryFilter: null,
    searchQuery: "",
    searchMode: false,
    paused: false,
    eventsPerSec: 0,
    service,
    running: true,
  }

  // Save original write functions
  _origStdoutWrite = process.stdout.write.bind(process.stdout)
  _origStderrWrite = process.stderr.write.bind(process.stderr)

  // Intercept raw stdout/stderr
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    const str = typeof chunk === "string" ? chunk : chunk.toString()
    // Skip our own TUI output (we write directly via _origStdoutWrite)
    if (str.includes("\x1b[?25l") || str.includes("\x1b[H")) return true
    // Capture as stdout event
    for (const line of str.split("\n").filter((l: string) => l.trim())) {
      // Skip JSON lines that are our own structured events
      if (line.startsWith("{\"ts\":")) continue
      pushRawEvent("stdout", line.trim())
    }
    return true
  }) as any

  process.stderr.write = ((chunk: any, ...args: any[]) => {
    const str = typeof chunk === "string" ? chunk : chunk.toString()
    for (const line of str.split("\n").filter((l: string) => l.trim())) {
      pushRawEvent("stderr", line.trim())
    }
    return true
  }) as any

  // Start rate counter
  _rateInterval = setInterval(() => {
    if (_state) {
      _state.eventsPerSec = _recentCount
      _recentCount = 0
      scheduleRender()
    }
  }, 1000)

  // Set up terminal
  setupTerminal()

  // Initial render
  scheduleRender()

  return { pushEvent, stop: stopTui }
}

export function isTuiActive(): boolean {
  return _state !== null && _state.running
}

// ── Event Ingestion ─────────────────────────────────────────────────────────

function pushEvent(event: { level: Level, message: string, attrs: Attrs, ts: number, file?: string, line?: number }) {
  if (!_state) return

  const category = (event.attrs._category as string) || (event.attrs._source as string) || ""
  if (category) _categories.add(category)

  const tuiEvent: TuiEvent = {
    id: _eventCounter++,
    ts: event.ts,
    level: event.level,
    message: event.message,
    attrs: event.attrs,
    category,
    file: event.file,
    line: event.line,
    expanded: false,
  }

  _state.events.push(tuiEvent)
  _recentCount++

  // Trim old events
  if (_state.events.length > MAX_EVENTS) {
    _state.events = _state.events.slice(-MAX_EVENTS)
  }

  recomputeFiltered()

  // Auto-scroll if not paused
  if (!_state.paused) {
    _state.selectedIdx = _state.filteredIndices.length - 1
  }

  scheduleRender()
}

function pushRawEvent(level: "stdout" | "stderr", message: string) {
  if (!_state) return

  const tuiEvent: TuiEvent = {
    id: _eventCounter++,
    ts: Date.now(),
    level,
    message,
    attrs: {},
    category: level,
    expanded: false,
  }

  _state.events.push(tuiEvent)
  _recentCount++

  if (_state.events.length > MAX_EVENTS) {
    _state.events = _state.events.slice(-MAX_EVENTS)
  }

  recomputeFiltered()
  if (!_state.paused) {
    _state.selectedIdx = _state.filteredIndices.length - 1
  }
  scheduleRender()
}

// ── Filtering ───────────────────────────────────────────────────────────────

function recomputeFiltered() {
  if (!_state) return
  const { events, severityFilter, categoryFilter, searchQuery } = _state
  const query = searchQuery.toLowerCase()

  _state.filteredIndices = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (!severityFilter.has(e.level)) continue
    if (categoryFilter && e.category !== categoryFilter) continue
    if (query && !e.message.toLowerCase().includes(query) && !JSON.stringify(e.attrs).toLowerCase().includes(query)) continue
    _state.filteredIndices.push(i)
  }
}

// ── Terminal Setup ──────────────────────────────────────────────────────────

function setupTerminal() {
  // Hide cursor, enable raw mode
  _origStdoutWrite!("\x1b[?25l") // hide cursor
  _origStdoutWrite!("\x1b[?1049h") // alt screen buffer

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on("data", handleKeypress)
  }
}

function teardownTerminal() {
  _origStdoutWrite!("\x1b[?1049l") // restore screen
  _origStdoutWrite!("\x1b[?25h") // show cursor

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
    process.stdin.removeListener("data", handleKeypress)
    process.stdin.pause()
  }
}

function stopTui() {
  if (!_state) return
  _state.running = false

  if (_rateInterval) clearInterval(_rateInterval)
  if (_renderTimeout) clearTimeout(_renderTimeout)

  teardownTerminal()

  // Restore stdout/stderr
  if (_origStdoutWrite) process.stdout.write = _origStdoutWrite as any
  if (_origStderrWrite) process.stderr.write = _origStderrWrite as any

  _state = null
}

// ── Input Handling ──────────────────────────────────────────────────────────

function handleKeypress(data: Buffer) {
  if (!_state) return
  const key = data.toString()
  const code = data[0]

  // Search mode input
  if (_state.searchMode) {
    if (key === "\x1b" || key === "\r") {
      // Escape or Enter: exit search mode
      _state.searchMode = false
      recomputeFiltered()
      scheduleRender()
      return
    }
    if (code === 127 || code === 8) {
      // Backspace
      _state.searchQuery = _state.searchQuery.slice(0, -1)
      recomputeFiltered()
      scheduleRender()
      return
    }
    if (code >= 32 && code < 127) {
      _state.searchQuery += key
      recomputeFiltered()
      scheduleRender()
      return
    }
    return
  }

  // Normal mode
  if (key === "q" || key === "\x03") {
    // q or Ctrl+C
    stopTui()
    process.exit(0)
    return
  }

  if (key === "\x1b[A" || key === "k") {
    // Up arrow or k
    if (_state.selectedIdx > 0) {
      _state.selectedIdx--
      _state.paused = true
    }
    scheduleRender()
    return
  }

  if (key === "\x1b[B" || key === "j") {
    // Down arrow or j
    if (_state.selectedIdx < _state.filteredIndices.length - 1) {
      _state.selectedIdx++
    }
    if (_state.selectedIdx === _state.filteredIndices.length - 1) {
      _state.paused = false
    }
    scheduleRender()
    return
  }

  if (key === "\r" || key === " ") {
    // Enter or Space: toggle expand
    const idx = _state.filteredIndices[_state.selectedIdx]
    if (idx !== undefined && _state.events[idx]) {
      _state.events[idx].expanded = !_state.events[idx].expanded
    }
    scheduleRender()
    return
  }

  if (key === "/") {
    _state.searchMode = true
    _state.searchQuery = ""
    scheduleRender()
    return
  }

  if (key === "\x1b") {
    // Escape: clear filters
    _state.searchQuery = ""
    _state.categoryFilter = null
    _state.severityFilter = new Set(SEVERITY_ORDER)
    recomputeFiltered()
    scheduleRender()
    return
  }

  if (key === "f") {
    // Cycle severity: all → warn+ → error+ → all
    const current = _state.severityFilter
    if (current.size === SEVERITY_ORDER.length) {
      _state.severityFilter = new Set(["warn", "error", "fatal", "stdout", "stderr"])
    } else if (current.has("warn") && !current.has("info")) {
      _state.severityFilter = new Set(["error", "fatal", "stderr"])
    } else {
      _state.severityFilter = new Set(SEVERITY_ORDER)
    }
    recomputeFiltered()
    scheduleRender()
    return
  }

  if (key === "\t") {
    // Tab: cycle category filter
    const cats = ["", ...Array.from(_categories).sort()]
    const currentIdx = cats.indexOf(_state.categoryFilter || "")
    _state.categoryFilter = cats[(currentIdx + 1) % cats.length] || null
    recomputeFiltered()
    scheduleRender()
    return
  }

  if (key === "c") {
    _state.events = []
    _state.filteredIndices = []
    _state.selectedIdx = -1
    _eventCounter = 0
    scheduleRender()
    return
  }

  if (key === "p") {
    _state.paused = !_state.paused
    if (!_state.paused) {
      _state.selectedIdx = _state.filteredIndices.length - 1
    }
    scheduleRender()
    return
  }

  // Number keys 1-6: toggle severity levels
  const num = parseInt(key)
  if (num >= 1 && num <= 6) {
    const level = SEVERITY_ORDER[num - 1]
    if (_state.severityFilter.has(level)) {
      _state.severityFilter.delete(level)
    } else {
      _state.severityFilter.add(level)
    }
    recomputeFiltered()
    scheduleRender()
    return
  }

  if (key === "G") {
    // Jump to bottom
    _state.selectedIdx = _state.filteredIndices.length - 1
    _state.paused = false
    scheduleRender()
    return
  }

  if (key === "g") {
    // Jump to top
    _state.selectedIdx = 0
    _state.paused = true
    scheduleRender()
    return
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function scheduleRender() {
  if (_renderTimeout) return
  _renderTimeout = setTimeout(() => {
    _renderTimeout = null
    render()
  }, 16) // ~60fps max
}

function render() {
  if (!_state || !_origStdoutWrite) return

  const cols = process.stdout.columns || 120
  const rows = process.stdout.rows || 40

  const lines: string[] = []

  // ── Header (1 line) ────────────────────────────────────────────────
  const headerLeft = `${GOLD}${BOLD} ▓ Aires${RESET}${DIM} · ${_state.service} · ${_state.events.length} events · ${_state.eventsPerSec}/s${RESET}`
  const pauseIndicator = _state.paused ? `${GOLD}${BOLD} ⏸ PAUSED${RESET}` : ""
  lines.push(headerLeft + pauseIndicator)

  // ── Filter bar (1 line) ────────────────────────────────────────────
  const filterParts: string[] = []

  // Severity toggles
  const sevLabels = SEVERITY_ORDER.slice(0, 6).map(s => {
    const active = _state!.severityFilter.has(s)
    const color = active ? SEVERITY_COLORS[s] : "\x1b[90m"
    const label = s.slice(0, 3).toUpperCase()
    return `${color}${active ? BOLD : ""}${label}${RESET}`
  })
  filterParts.push(sevLabels.join(" "))

  if (_state.categoryFilter) {
    filterParts.push(`${DIM}cat:${RESET}${GOLD}${_state.categoryFilter}${RESET}`)
  }

  if (_state.searchMode) {
    filterParts.push(`${GOLD}/${RESET}${_state.searchQuery}${GOLD}▌${RESET}`)
  } else if (_state.searchQuery) {
    filterParts.push(`${DIM}search:${RESET}${_state.searchQuery}`)
  }

  lines.push(` ${filterParts.join(`${DIM} │ ${RESET}`)}`)

  // ── Separator ──────────────────────────────────────────────────────
  lines.push(`${DIM}${"─".repeat(cols)}${RESET}`)

  // ── Events (fill remaining space) ──────────────────────────────────
  const footerHeight = 1
  const headerHeight = lines.length
  const availableRows = rows - headerHeight - footerHeight

  // Determine visible window
  const { filteredIndices, selectedIdx, events } = _state
  const totalFiltered = filteredIndices.length

  // Calculate which lines each event takes (1 for collapsed, more for expanded)
  const eventLines: Array<{ eventIdx: number, lines: string[] }> = []
  for (const fIdx of filteredIndices) {
    const e = events[fIdx]
    const el = formatEvent(e, cols)
    eventLines.push({ eventIdx: fIdx, lines: el })
  }

  // Find viewport: ensure selected event is visible
  let totalLineCount = 0
  const lineCounts = eventLines.map(el => el.lines.length)

  // Simple approach: scroll so selected is in view
  let startEventIdx = 0
  let currentLines = 0

  // Scroll to make selected visible
  if (selectedIdx >= 0) {
    // Count lines from selectedIdx backward until we fill half the screen
    let linesBeforeSelected = 0
    for (let i = 0; i < selectedIdx; i++) {
      linesBeforeSelected += lineCounts[i]
    }

    const halfScreen = Math.floor(availableRows / 2)
    // Find start event so selected is roughly centered
    currentLines = 0
    startEventIdx = 0
    let targetLinesBefore = Math.max(0, linesBeforeSelected - halfScreen)
    let accum = 0
    for (let i = 0; i < eventLines.length; i++) {
      if (accum >= targetLinesBefore) {
        startEventIdx = i
        break
      }
      accum += lineCounts[i]
    }
  }

  // Render visible events
  let renderedLines = 0
  for (let i = startEventIdx; i < eventLines.length && renderedLines < availableRows; i++) {
    const el = eventLines[i]
    const isSelected = (i === selectedIdx)

    for (const line of el.lines) {
      if (renderedLines >= availableRows) break
      if (isSelected) {
        lines.push(`${INVERSE}${line}${RESET}`)
      } else {
        lines.push(line)
      }
      renderedLines++
    }
  }

  // Fill remaining with empty lines
  while (renderedLines < availableRows) {
    lines.push("")
    renderedLines++
  }

  // ── Footer (1 line) ────────────────────────────────────────────────
  const footerItems = [
    `${DIM}↑↓${RESET} nav`,
    `${DIM}⏎${RESET} expand`,
    `${DIM}f${RESET} filter`,
    `${DIM}/${RESET} search`,
    `${DIM}⇥${RESET} category`,
    `${DIM}p${RESET} pause`,
    `${DIM}c${RESET} clear`,
    `${DIM}q${RESET} quit`,
  ]
  const footerRight = `${DIM}${totalFiltered}/${_state.events.length}${RESET}`
  lines.push(` ${footerItems.join("  ")}  ${footerRight}`)

  // ── Write to terminal ──────────────────────────────────────────────
  // Move cursor to top-left, clear screen, write all lines
  let output = "\x1b[H" // cursor home
  for (let i = 0; i < lines.length && i < rows; i++) {
    // Truncate line to terminal width (accounting for ANSI codes)
    output += lines[i] + "\x1b[K\n" // clear to end of line
  }

  _origStdoutWrite!(output)
}

// ── Event Formatting ────────────────────────────────────────────────────────

function formatEvent(e: TuiEvent, cols: number): string[] {
  const lines: string[] = []

  // Time
  const d = new Date(e.ts)
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`

  // Severity
  const sevColor = SEVERITY_COLORS[e.level] || ""
  const sevLabel = e.level === "stdout" ? "···" : e.level === "stderr" ? "ERR" : e.level.slice(0, 3).toUpperCase()

  // Category
  const cat = e.category ? `[${e.category}]` : ""

  // Message (truncate for main line)
  const prefix = ` ${DIM}${time}${RESET} ${sevColor}${BOLD}${padRight(sevLabel, 5)}${RESET} ${DIM}${padRight(cat, 10)}${RESET} `
  const prefixVisualLen = time.length + 1 + 5 + 1 + Math.min(cat.length, 10) + 3
  const msgSpace = cols - prefixVisualLen - 1
  const msg = e.message.length > msgSpace && !e.expanded
    ? e.message.slice(0, msgSpace - 1) + "…"
    : e.message

  // Color the message based on content
  let msgColor = ""
  if (e.level === "error" || e.level === "fatal") msgColor = SEVERITY_COLORS[e.level]
  else if (e.level === "warn") msgColor = SEVERITY_COLORS.warn
  else if (e.level === "stdout" || e.level === "stderr") msgColor = DIM

  lines.push(`${prefix}${msgColor}${msg}${RESET}`)

  // Expanded details
  if (e.expanded) {
    const indent = "   "
    const attrs = e.attrs || {}
    const keys = Object.keys(attrs).filter(k => !k.startsWith("_"))

    if (keys.length > 0) {
      for (const key of keys) {
        const val = attrs[key]
        const valStr = typeof val === "string" ? val : JSON.stringify(val)
        lines.push(`${indent}${DIM}${key}:${RESET} ${valStr}`)
      }
    }

    // Internal attrs (_ prefixed)
    const internalKeys = Object.keys(attrs).filter(k => k.startsWith("_"))
    if (internalKeys.length > 0) {
      for (const key of internalKeys) {
        const val = attrs[key]
        const valStr = typeof val === "string" ? val : JSON.stringify(val)
        lines.push(`${indent}${DIM}${key}: ${valStr}${RESET}`)
      }
    }

    if (e.file) {
      lines.push(`${indent}${DIM}source: ${e.file}:${e.line || 0}${RESET}`)
    }

    // Blank line after expanded event
    lines.push("")
  }

  return lines
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function pad3(n: number): string {
  return n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length)
}
