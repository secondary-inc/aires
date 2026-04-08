#!/usr/bin/env bun
/**
 * aires-dev — Development launcher with fullscreen TUI
 *
 * Replaces `concurrently` by spawning child processes and capturing
 * ALL their output into a fullscreen terminal log viewer.
 *
 * Usage:
 *   aires-dev --names api,app,axiom "cmd1" "cmd2" "cmd3"
 */

import { spawn, type ChildProcess } from "node:child_process"

// ── ANSI ────────────────────────────────────────────────────────────────────

const R = "\x1b[0m"
const B = "\x1b[1m"
const D = "\x1b[2m"
const INV = "\x1b[7m"
const UL = "\x1b[4m"

const C: Record<string, string> = {
  trace: "\x1b[90m", debug: "\x1b[35m", info: "\x1b[36m",
  warn: "\x1b[33m", error: "\x1b[31m", fatal: "\x1b[97;41m",
  stdout: "\x1b[37m", stderr: "\x1b[91m",
}
const PC = ["\x1b[34m", "\x1b[32m", "\x1b[35m", "\x1b[36m", "\x1b[33m", "\x1b[91m"]
const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "stdout", "stderr"]

// ── Types ───────────────────────────────────────────────────────────────────

interface Ev {
  id: number
  ts: number
  level: string
  msg: string
  attrs: Record<string, unknown>
  cat: string
  src: string
  expanded: boolean
}

type ColId = "time" | "level" | "source" | "category" | "message"

interface Col {
  id: ColId
  label: string
  width: number  // 0 = flex
  visible: boolean
}

// ── State ───────────────────────────────────────────────────────────────────

const MAX = 10000

const columns: Col[] = [
  { id: "time",     label: "TIME",     width: 12, visible: false },
  { id: "level",    label: "LEVEL",    width: 5,  visible: true },
  { id: "source",   label: "SRC",      width: 6,  visible: true },
  { id: "category", label: "CAT",      width: 12, visible: true },
  { id: "message",  label: "MESSAGE",  width: 0,  visible: true },
]

const st = {
  evs: [] as Ev[],
  filt: [] as number[],
  sel: -1,
  levels: new Set(LEVELS),
  srcFilter: null as string | null,
  catFilter: null as string | null,
  search: "",
  searchMode: false,
  paused: false,
  eps: 0,
  names: [] as string[],
  children: [] as ChildProcess[],
  // UI modes
  showLevelPicker: false,
  showColPicker: false,
}

let eid = 0
let recent = 0
let rtimer: ReturnType<typeof setTimeout> | null = null
const cats = new Set<string>()
// Dedup: track recently seen structured messages to skip their raw echo
const recentStructured = new Map<string, number>()

// ── Args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
let names: string[] = []
const cmds: string[] = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--names" || argv[i] === "-n") names = (argv[++i] || "").split(",").map(s => s.trim())
  else if (!argv[i].startsWith("-")) cmds.push(argv[i])
}
if (!cmds.length) { console.error("Usage: aires-dev [--names a,b] 'cmd1' 'cmd2'"); process.exit(1) }
if (!names.length) names = cmds.map((_, i) => `p${i}`)
st.names = names

// ── Events ──────────────────────────────────────────────────────────────────

function push(src: string, level: string, msg: string, attrs: Record<string, unknown> = {}, cat = "") {
  if (cat) cats.add(cat)
  st.evs.push({ id: eid++, ts: Date.now(), level, msg, attrs, cat, src, expanded: false })
  recent++
  if (st.evs.length > MAX) st.evs = st.evs.slice(-MAX)
  refilter()
  if (!st.paused) st.sel = st.filt.length - 1
  scheduleRender()
}

function handleLine(src: string, raw: string, stderr: boolean) {
  const t = raw.trim()
  if (!t) return

  // Try structured Aires JSON
  if (t.charAt(0) === "{" && t.includes('"ts"')) {
    try {
      const j = JSON.parse(t)
      if (j.ts && j.level && j.message !== undefined) {
        const cat = j.attrs?._category || j.attrs?._source || ""
        if (j.attrs?._metric) return // skip metrics
        // Mark this message as structured so we can dedup the raw echo
        recentStructured.set(`${src}:${j.message}`, Date.now())
        push(src, j.level, j.message, j.attrs || {}, cat)
        return
      }
    } catch {}
  }

  // Dedup: skip raw lines that duplicate a recently seen structured event
  const dedupKey = `${src}:${t}`
  const seen = recentStructured.get(dedupKey)
  if (seen && Date.now() - seen < 2000) {
    recentStructured.delete(dedupKey)
    return
  }

  // Also dedup partial matches — structured logs often have extra context stripped
  for (const [key, time] of recentStructured) {
    if (Date.now() - time > 2000) { recentStructured.delete(key); continue }
    const msgPart = key.split(":").slice(1).join(":")
    if (t.includes(msgPart) || msgPart.includes(t)) {
      recentStructured.delete(key)
      return
    }
  }

  push(src, stderr ? "stderr" : "stdout", t)
}

// ── Filter ──────────────────────────────────────────────────────────────────

function refilter() {
  const q = st.search.toLowerCase()
  st.filt = []
  for (let i = 0; i < st.evs.length; i++) {
    const e = st.evs[i]
    if (!st.levels.has(e.level)) continue
    if (st.srcFilter && e.src !== st.srcFilter) continue
    if (st.catFilter && e.cat !== st.catFilter) continue
    if (q && !e.msg.toLowerCase().includes(q) && !e.cat.toLowerCase().includes(q)) continue
    st.filt.push(i)
  }
}

// ── Processes ───────────────────────────────────────────────────────────────

function spawnAll() {
  for (let i = 0; i < cmds.length; i++) {
    const name = names[i] || `p${i}`
    const child = spawn("sh", ["-c", cmds[i]], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1", AIRES_TUI: "0" },
      cwd: process.cwd(),
    })
    let stdoutBuf = ""
    let stderrBuf = ""
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split("\n")
      stdoutBuf = lines.pop()! // keep incomplete line
      for (const l of lines) handleLine(name, l, false)
    })
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString()
      const lines = stderrBuf.split("\n")
      stderrBuf = lines.pop()!
      for (const l of lines) handleLine(name, l, true)
    })
    child.on("exit", (code) => push(name, code === 0 ? "info" : "error", `exited (code ${code})`))
    st.children.push(child)
  }
}

// ── Terminal ────────────────────────────────────────────────────────────────

function setup() {
  process.stdout.write("\x1b[?25l\x1b[?1049h\x1b[2J")
  if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onKey) }
}
function teardown() {
  process.stdout.write("\x1b[?1049l\x1b[?25h")
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
}
function die() { teardown(); for (const c of st.children) { try { c.kill("SIGTERM") } catch {} }; process.exit(0) }

// ── Input ───────────────────────────────────────────────────────────────────

function onKey(data: Buffer) {
  const k = data.toString()
  const c0 = data[0]

  // Level picker mode
  if (st.showLevelPicker) {
    const n = parseInt(k)
    if (n >= 1 && n <= LEVELS.length) {
      const lv = LEVELS[n - 1]
      st.levels.has(lv) ? st.levels.delete(lv) : st.levels.add(lv)
      refilter(); scheduleRender(); return
    }
    if (k === "a") { st.levels = new Set(LEVELS); refilter(); scheduleRender(); return }
    // Any other key exits the picker
    st.showLevelPicker = false; scheduleRender(); return
  }

  // Column picker mode
  if (st.showColPicker) {
    const n = parseInt(k)
    if (n >= 1 && n <= columns.length) {
      columns[n - 1].visible = !columns[n - 1].visible
      scheduleRender(); return
    }
    st.showColPicker = false; scheduleRender(); return
  }

  // Search mode
  if (st.searchMode) {
    if (k === "\x1b" || k === "\r") { st.searchMode = false; refilter(); scheduleRender(); return }
    if (c0 === 127 || c0 === 8) { st.search = st.search.slice(0, -1); refilter(); scheduleRender(); return }
    if (c0 >= 32 && c0 < 127) { st.search += k; refilter(); scheduleRender(); return }
    return
  }

  if (k === "q" || k === "\x03") { die(); return }
  if (k === "\x1b[A" || k === "k") { if (st.sel > 0) { st.sel--; st.paused = true }; scheduleRender(); return }
  if (k === "\x1b[B" || k === "j") {
    if (st.sel < st.filt.length - 1) st.sel++
    if (st.sel === st.filt.length - 1) st.paused = false
    scheduleRender(); return
  }
  if (k === "\r" || k === " ") {
    const idx = st.filt[st.sel]
    if (idx !== undefined) st.evs[idx].expanded = !st.evs[idx].expanded
    scheduleRender(); return
  }
  if (k === "/") { st.searchMode = true; st.search = ""; scheduleRender(); return }
  if (k === "\x1b") { st.search = ""; st.catFilter = null; st.srcFilter = null; st.levels = new Set(LEVELS); refilter(); scheduleRender(); return }
  if (k === "l") { st.showLevelPicker = true; scheduleRender(); return }
  if (k === "v") { st.showColPicker = true; scheduleRender(); return }
  if (k === "\t") {
    const s = [null, ...st.names]
    st.srcFilter = s[(s.indexOf(st.srcFilter) + 1) % s.length]
    refilter(); scheduleRender(); return
  }
  if (k === "s") {
    const c = [null, ...Array.from(cats).sort()]
    st.catFilter = c[(c.indexOf(st.catFilter) + 1) % c.length]
    refilter(); scheduleRender(); return
  }
  if (k === "c") { st.evs = []; st.filt = []; st.sel = -1; eid = 0; scheduleRender(); return }
  if (k === "p") { st.paused = !st.paused; if (!st.paused) st.sel = st.filt.length - 1; scheduleRender(); return }
  if (k === "G") { st.sel = st.filt.length - 1; st.paused = false; scheduleRender(); return }
  if (k === "g") { st.sel = 0; st.paused = true; scheduleRender(); return }
}

// ── Render ──────────────────────────────────────────────────────────────────

function scheduleRender() {
  if (rtimer) return
  rtimer = setTimeout(() => { rtimer = null; render() }, 16)
}

function truncOrPad(s: string, w: number): string {
  if (s.length > w) return s.slice(0, w - 1) + "…"
  return s + " ".repeat(w - s.length)
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length
}

function render() {
  const W = process.stdout.columns || 120
  const H = process.stdout.rows || 40
  const out: string[] = []

  // ── Header (line 0) ──────────────────────────────────────────
  const procs = st.names.map((n, i) => {
    const c = PC[i % PC.length]
    const on = !st.srcFilter || st.srcFilter === n
    return `${on ? c + B : D}${n}${R}`
  }).join(" ")
  const pause = st.paused ? ` \x1b[33;1m⏸${R}` : ""
  out.push(` \x1b[33;1m▓ Aires${R} ${procs}${D} · ${st.evs.length} events · ${st.eps}/s${R}${pause}`)

  // ── Filter chips (line 1) ─────────────────────────────────────
  const chips: string[] = []
  if (st.srcFilter) chips.push(`${D}src:${R}\x1b[33m${st.srcFilter}${R}`)
  if (st.catFilter) chips.push(`${D}cat:${R}\x1b[33m${st.catFilter}${R}`)
  if (st.search) chips.push(`${D}search:${R}${st.search}`)
  if (st.searchMode) chips.push(`\x1b[33m/${R}${st.search}\x1b[33m▌${R}`)
  const levHidden = LEVELS.slice(0, 6).filter(l => !st.levels.has(l))
  if (levHidden.length > 0) chips.push(`${D}hidden:${R}${D}${levHidden.map(l => l.slice(0,3)).join(",")}${R}`)
  out.push(chips.length ? ` ${chips.join(`${D} │ ${R}`)}` : "")

  // ── Column headers (line 2) ───────────────────────────────────
  const visCols = columns.filter(c => c.visible)
  const fixedW = visCols.reduce((s, c) => s + (c.width || 0), 0) + visCols.length // +1 gap each
  const flexW = Math.max(10, W - fixedW - 2)

  let hdr = " "
  for (const col of visCols) {
    const w = col.width || flexW
    hdr += `${D}${truncOrPad(col.label, w)}${R} `
  }
  out.push(hdr)

  // Separator
  out.push(`${D}${"─".repeat(W)}${R}`)

  // ── Determine visible window ──────────────────────────────────
  const bodyStart = out.length
  const footerH = 1
  const bodyH = H - bodyStart - footerH

  // Each non-expanded event = 1 line, expanded = 1 + attr count + 1 blank
  const rowHeights: number[] = []
  for (const fi of st.filt) {
    const e = st.evs[fi]
    if (e.expanded) {
      const attrCount = Object.keys(e.attrs).filter(k => k !== "_metric" && k !== "_metricValue").length
      rowHeights.push(1 + attrCount + 1)
    } else {
      rowHeights.push(1)
    }
  }

  // Find scroll offset so selected row is visible.
  // Key behavior: selected row should be visible, and when at the bottom
  // (auto-scroll), we show as many events as fit with the newest at the bottom.
  let scrollStart = 0
  if (st.sel >= 0) {
    // Total lines from scrollStart to selected (inclusive) must fit in bodyH.
    // Work backwards from selected to find the first event that fits.
    let linesFromSelBack = 0
    scrollStart = st.sel
    for (let i = st.sel; i >= 0; i--) {
      const h = rowHeights[i] || 1
      if (linesFromSelBack + h > bodyH) break
      linesFromSelBack += h
      scrollStart = i
    }
  }

  // Render rows — events stick to the bottom like a terminal.
  // First, collect all visible row lines.
  const visibleLines: Array<{ line: string, eventIdx: number }> = []
  for (let i = scrollStart; i < st.filt.length; i++) {
    const e = st.evs[st.filt[i]]
    const isSel = i === st.sel
    const rowLines = formatRow(e, visCols, flexW, W)
    for (const rl of rowLines) {
      visibleLines.push({ line: isSel ? `${INV}${rl}${R}` : rl, eventIdx: i })
    }
  }

  // Only take the last bodyH lines (so events fill from bottom up)
  const displayLines = visibleLines.slice(-bodyH)

  // Pad top with empty lines so content is bottom-aligned
  const emptyTop = bodyH - displayLines.length
  for (let i = 0; i < emptyTop; i++) out.push("")
  for (const dl of displayLines) out.push(dl.line)

  // ── Footer ────────────────────────────────────────────────────
  const fl = [
    `${D}↑↓${R} scroll`,
    `${D}⏎${R} expand`,
    `${D}/${R} search`,
    `${D}⇥${R} source`,
    `${D}s${R} category`,
    `${D}l${R} levels`,
    `${D}v${R} columns`,
    `${D}p${R} pause`,
    `${D}c${R} clear`,
    `${D}q${R} quit`,
  ]
  out.push(` ${fl.join("  ")}  ${D}${st.filt.length}/${st.evs.length}${R}`)

  // ── Overlay: level picker ─────────────────────────────────────
  if (st.showLevelPicker) {
    const ox = 2, oy = 3, ow = 30
    for (let li = 0; li < LEVELS.length + 2; li++) {
      const y = oy + li
      if (y >= H) break
      let line = ""
      if (li === 0) {
        line = `\x1b[${y + 1};${ox + 1}H\x1b[48;5;236m${B} Log Levels ${" ".repeat(ow - 12)}${R}`
      } else if (li <= LEVELS.length) {
        const lv = LEVELS[li - 1]
        const on = st.levels.has(lv)
        const check = on ? `\x1b[32m✓${R}` : `${D}·${R}`
        const color = C[lv] || ""
        line = `\x1b[${y + 1};${ox + 1}H\x1b[48;5;236m ${check} ${D}${li}${R}\x1b[48;5;236m ${color}${lv}${R}\x1b[48;5;236m${" ".repeat(Math.max(0, ow - lv.length - 7))}${R}`
      } else {
        line = `\x1b[${y + 1};${ox + 1}H\x1b[48;5;236m ${D}a${R}\x1b[48;5;236m all  ${D}any key${R}\x1b[48;5;236m close${" ".repeat(Math.max(0, ow - 22))}${R}`
      }
      out.push(line)
    }
  }

  // ── Overlay: column picker ────────────────────────────────────
  if (st.showColPicker) {
    const ox = 2, oy = 3, ow = 30
    for (let li = 0; li < columns.length + 1; li++) {
      const y = oy + li
      if (y >= H) break
      let line = ""
      if (li === 0) {
        line = `\x1b[${y + 1};${ox + 1}H\x1b[48;5;236m${B} Columns ${" ".repeat(ow - 9)}${R}`
      } else {
        const col = columns[li - 1]
        const on = col.visible
        const check = on ? `\x1b[32m✓${R}` : `${D}·${R}`
        line = `\x1b[${y + 1};${ox + 1}H\x1b[48;5;236m ${check} ${D}${li}${R}\x1b[48;5;236m ${col.label.toLowerCase()}${" ".repeat(Math.max(0, ow - col.label.length - 7))}${R}`
      }
      out.push(line)
    }
  }

  // ── Write ─────────────────────────────────────────────────────
  // Use absolute positioning for each line to ensure we fill the full screen
  let buf = "\x1b[H" // home
  for (let i = 0; i < H; i++) {
    if (i < out.length) {
      buf += out[i]
    }
    buf += "\x1b[K" // clear to end of line
    if (i < H - 1) buf += "\n"
  }
  process.stdout.write(buf)
}

function formatRow(e: Ev, visCols: Col[], flexW: number, totalW: number): string[] {
  const lines: string[] = []

  // Build the main row
  let row = " "
  for (const col of visCols) {
    const w = col.width || flexW
    switch (col.id) {
      case "time": {
        const d = new Date(e.ts)
        const t = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
        row += `${D}${t}${R} `
        break
      }
      case "level": {
        const lv = e.level === "stdout" ? "out" : e.level === "stderr" ? "err" : e.level.slice(0, 3)
        row += `${C[e.level] || ""}${B}${truncOrPad(lv.toUpperCase(), w)}${R} `
        break
      }
      case "source": {
        const ci = st.names.indexOf(e.src)
        const color = ci >= 0 ? PC[ci % PC.length] : D
        row += `${color}${truncOrPad(e.src, w)}${R} `
        break
      }
      case "category": {
        row += `${D}${truncOrPad(e.cat, w)}${R} `
        break
      }
      case "message": {
        let mc = ""
        if (e.level === "error" || e.level === "fatal") mc = C[e.level]
        else if (e.level === "warn") mc = C.warn
        else if (e.level === "stdout" || e.level === "stderr") mc = D
        const msg = e.msg.length > w ? e.msg.slice(0, w - 1) + "…" : e.msg
        row += `${mc}${msg}${R}`
        break
      }
    }
  }
  lines.push(row)

  // Expanded attrs
  if (e.expanded) {
    const indent = " ".repeat(3)
    for (const [k, v] of Object.entries(e.attrs)) {
      if (k === "_metric" || k === "_metricValue") continue
      const vs = typeof v === "string" ? v : JSON.stringify(v)
      lines.push(`${indent}${D}${k}${R} ${vs}`)
    }
    lines.push("") // blank spacer
  }

  return lines
}

function p2(n: number): string { return n < 10 ? `0${n}` : `${n}` }
function p3(n: number): string { return n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}` }

// ── Main ────────────────────────────────────────────────────────────────────

process.on("SIGINT", die)
process.on("SIGTERM", die)

setup()
setInterval(() => { st.eps = recent; recent = 0; scheduleRender() }, 1000)
spawnAll()
scheduleRender()
push("aires", "info", `Launched ${cmds.length} process(es): ${names.join(", ")}`)
