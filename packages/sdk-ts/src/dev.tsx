#!/usr/bin/env bun
/**
 * aires-dev — Development launcher with OpenTUI terminal interface
 *
 * Proper TUI built on OpenTUI (yoga flexbox) + SolidJS (reactivity).
 * Spawns child processes, captures all output, renders in a real TUI
 * with scrollable log view, column headers, level/column pickers,
 * keyboard navigation, search, and source filtering.
 *
 * Usage:
 *   aires-dev --names api,app,axiom "cmd1" "cmd2" "cmd3"
 */

import { spawn, type ChildProcess } from "node:child_process"
import { createSignal, createMemo, For, Show } from "solid-js"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createCliRenderer } from "@opentui/core"

// ── Types ───────────────────────────────────────────────────────────────────

interface Ev {
  id: number
  ts: number
  level: string
  msg: string
  attrs: Record<string, unknown>
  cat: string
  src: string
}

type ColId = "time" | "level" | "source" | "category" | "message"

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "stdout", "stderr"]
const LEVEL_COLORS: Record<string, string> = {
  trace: "#6b7280", debug: "#a855f7", info: "#22d3ee",
  warn: "#eab308", error: "#ef4444", fatal: "#dc2626",
  stdout: "#9ca3af", stderr: "#f87171",
}
const SRC_COLORS = ["#60a5fa", "#34d399", "#c084fc", "#22d3ee", "#facc15", "#fb923c"]

// ── Parse Args ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
let names: string[] = []
const cmds: string[] = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--names" || argv[i] === "-n") names = (argv[++i] || "").split(",").map(s => s.trim())
  else if (!argv[i].startsWith("-")) cmds.push(argv[i])
}
if (!cmds.length) { console.error("Usage: aires-dev [--names a,b] 'cmd1' 'cmd2'"); process.exit(1) }
if (!names.length) names = cmds.map((_, i) => `p${i}`)

// ── Reactive State ──────────────────────────────────────────────────────────

const [events, setEvents] = createSignal<Ev[]>([])
const [selectedIdx, setSelectedIdx] = createSignal(-1)
const [expandedIds, setExpandedIds] = createSignal<Set<number>>(new Set())
const [enabledLevels, setEnabledLevels] = createSignal<Set<string>>(new Set(LEVELS))
const [visibleCols, setVisibleCols] = createSignal<Set<ColId>>(new Set(["level", "source", "category", "message"]))
const [srcFilter, setSrcFilter] = createSignal<string | null>(null)
const [searchQuery, setSearchQuery] = createSignal("")
const [searchMode, setSearchMode] = createSignal(false)
const [paused, setPaused] = createSignal(false)
const [showLevelPicker, setShowLevelPicker] = createSignal(false)
const [showColPicker, setShowColPicker] = createSignal(false)
const [eps, setEps] = createSignal(0)

let eid = 0
let recentCount = 0
const recentStructured = new Map<string, number>()

// ── Filtered events ─────────────────────────────────────────────────────────

const filtered = createMemo(() => {
  const evs = events()
  const levels = enabledLevels()
  const src = srcFilter()
  const q = searchQuery().toLowerCase()
  return evs.filter(e => {
    if (!levels.has(e.level)) return false
    if (src && e.src !== src) return false
    if (q && !e.msg.toLowerCase().includes(q) && !e.cat.toLowerCase().includes(q)) return false
    return true
  })
})

// ── Event Ingestion ─────────────────────────────────────────────────────────

function push(src: string, level: string, msg: string, attrs: Record<string, unknown> = {}, cat = "") {
  const ev: Ev = { id: eid++, ts: Date.now(), level, msg, attrs, cat, src }
  setEvents(prev => {
    const next = [...prev, ev]
    return next.length > 10000 ? next.slice(-10000) : next
  })
  recentCount++
  if (!paused()) setSelectedIdx(filtered().length)
}

function handleLine(src: string, raw: string, stderr: boolean) {
  const t = raw.trim()
  if (!t) return
  if (t.charAt(0) === "{" && t.includes('"ts"')) {
    try {
      const j = JSON.parse(t)
      if (j.ts && j.level && j.message !== undefined) {
        const cat = j.attrs?._category || j.attrs?._source || ""
        if (j.attrs?._metric) return
        recentStructured.set(`${src}:${j.message}`, Date.now())
        push(src, j.level, j.message, j.attrs || {}, cat)
        return
      }
    } catch {}
  }
  const key = `${src}:${t}`
  const seen = recentStructured.get(key)
  if (seen && Date.now() - seen < 2000) { recentStructured.delete(key); return }
  for (const [k, time] of recentStructured) {
    if (Date.now() - time > 2000) { recentStructured.delete(k); continue }
    const mp = k.split(":").slice(1).join(":")
    if (t.includes(mp) || mp.includes(t)) { recentStructured.delete(k); return }
  }
  push(src, stderr ? "stderr" : "stdout", t)
}

// ── Process Management ──────────────────────────────────────────────────────

const children: ChildProcess[] = []

function spawnAll() {
  for (let i = 0; i < cmds.length; i++) {
    const name = names[i] || `p${i}`
    const child = spawn("sh", ["-c", cmds[i]], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1", AIRES_TUI: "0" },
      cwd: process.cwd(),
    })
    let ob = "", eb = ""
    child.stdout!.on("data", (c: Buffer) => {
      ob += c.toString()
      const ls = ob.split("\n")
      ob = ls.pop()!
      for (const l of ls) handleLine(name, l, false)
    })
    child.stderr!.on("data", (c: Buffer) => {
      eb += c.toString()
      const ls = eb.split("\n")
      eb = ls.pop()!
      for (const l of ls) handleLine(name, l, true)
    })
    child.on("exit", (code) => push(name, code === 0 ? "info" : "error", `exited (code ${code})`))
    children.push(child)
  }
}

function cleanup() {
  for (const c of children) { try { c.kill("SIGTERM") } catch {} }
  process.exit(0)
}
process.on("SIGINT", cleanup)
process.on("SIGTERM", cleanup)

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`
}

function fmtLevel(level: string): string {
  if (level === "stdout") return "OUT"
  if (level === "stderr") return "ERR"
  return level.slice(0, 3).toUpperCase()
}

// ── Components ──────────────────────────────────────────────────────────────
// OpenTUI rule: <text> only accepts plain strings. Use <span> for inline styled segments.
// Reactive values must be .toString() or template-literal'd into strings.

function Header() {
  const headerText = () => {
    const parts = names.map((n, i) => n).join(" ")
    const p = paused() ? " ⏸ PAUSED" : ""
    return `▓ Aires  ${parts}  · ${String(events().length)} events · ${String(eps())}/s${p}`
  }
  return (
    <box height={1} paddingX={1}>
      <text fg="#eab308">{headerText()}</text>
    </box>
  )
}

function FilterBar() {
  const filterText = () => {
    const parts: string[] = []
    if (srcFilter()) parts.push(`src:${srcFilter()}`)
    if (searchMode()) parts.push(`/${searchQuery()}▌`)
    else if (searchQuery()) parts.push(`search:${searchQuery()}`)
    const hidden = LEVELS.slice(0, 6).filter(l => !enabledLevels().has(l))
    if (hidden.length > 0) parts.push(`hidden:${hidden.map(l => l.slice(0,3)).join(",")}`)
    return parts.join("  ")
  }
  return (
    <Show when={filterText().length > 0}>
      <box height={1} paddingX={1}>
        <text fg="#888">{filterText()}</text>
      </box>
    </Show>
  )
}

function ColHeaders() {
  const cols = visibleCols()
  const headerText = () => {
    const parts: string[] = []
    if (cols.has("time")) parts.push("TIME".padEnd(13))
    if (cols.has("level")) parts.push("LEVEL".padEnd(6))
    if (cols.has("source")) parts.push("SRC".padEnd(7))
    if (cols.has("category")) parts.push("CAT".padEnd(13))
    if (cols.has("message")) parts.push("MESSAGE")
    return parts.join("")
  }
  return (
    <box height={1} paddingX={1}>
      <text fg="#555">{headerText()}</text>
    </box>
  )
}

function EventRow(props: { ev: Ev, selected: boolean, expanded: boolean }) {
  const cols = visibleCols()
  const lc = () => LEVEL_COLORS[props.ev.level] || "#666"
  const mc = () => {
    if (props.ev.level === "error" || props.ev.level === "fatal") return LEVEL_COLORS[props.ev.level]
    if (props.ev.level === "warn") return "#eab308"
    if (props.ev.level === "stdout" || props.ev.level === "stderr") return "#888"
    return "#e5e5e5"
  }

  const rowText = () => {
    const parts: string[] = []
    if (cols.has("time")) parts.push(fmtTime(props.ev.ts).padEnd(13))
    if (cols.has("level")) parts.push(fmtLevel(props.ev.level).padEnd(6))
    if (cols.has("source")) parts.push(props.ev.src.slice(0, 6).padEnd(7))
    if (cols.has("category")) parts.push(props.ev.cat.slice(0, 12).padEnd(13))
    if (cols.has("message")) parts.push(props.ev.msg)
    return parts.join("")
  }

  return (
    <box flexDirection="column">
      <box height={1} paddingX={1} backgroundColor={props.selected ? "#333" : "transparent"}>
        <text fg={mc()}>{rowText()}</text>
      </box>
      <Show when={props.expanded}>
        <For each={Object.entries(props.ev.attrs).filter(([k]) => k !== "_metric" && k !== "_metricValue")}>
          {([key, val]) => (
            <box height={1} paddingLeft={4}>
              <text fg="#888">{`${key} ${typeof val === "string" ? val : JSON.stringify(val)}`}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

function Overlay(props: { title: string, items: Array<{ label: string, on: boolean, key: string, color?: string }> }) {
  return (
    <box position="absolute" left={2} top={3} width={28} flexDirection="column" border borderStyle="rounded" backgroundColor="#1a1a1a" padding={1}>
      <text fg="#fff">{props.title}</text>
      <For each={props.items}>
        {(item) => (
          <box height={1}>
            <text fg={item.on ? "#22c55e" : "#555"}>{`${item.on ? "✓" : "·"} ${item.key} ${item.label}`}</text>
          </box>
        )}
      </For>
      <text fg="#666">{"press key to toggle · any other to close"}</text>
    </box>
  )
}

function Footer() {
  const footerText = () => {
    const f = filtered()
    return `↑↓ scroll  ⏎ expand  / search  ⇥ source  l levels  v columns  p pause  c clear  q quit    ${String(f.length)}/${String(events().length)}`
  }
  return (
    <box height={1} paddingX={1}>
      <text fg="#666">{footerText()}</text>
    </box>
  )
}

// ── Root App ────────────────────────────────────────────────────────────────

function App() {
  const dims = useTerminalDimensions()

  useKeyboard((key) => {
    if (showLevelPicker()) {
      const n = parseInt(key.sequence || "")
      if (n >= 1 && n <= LEVELS.length) {
        setEnabledLevels(prev => { const s = new Set(prev); const lv = LEVELS[n-1]; s.has(lv) ? s.delete(lv) : s.add(lv); return s })
        return
      }
      if (key.name === "a") { setEnabledLevels(new Set(LEVELS)); return }
      setShowLevelPicker(false); return
    }
    if (showColPicker()) {
      const n = parseInt(key.sequence || "")
      const ids: ColId[] = ["time", "level", "source", "category", "message"]
      if (n >= 1 && n <= ids.length) {
        setVisibleCols(prev => { const s = new Set(prev); const id = ids[n-1]; s.has(id) ? s.delete(id) : s.add(id); return s })
        return
      }
      setShowColPicker(false); return
    }
    if (searchMode()) {
      if (key.name === "escape" || key.name === "return") { setSearchMode(false); return }
      if (key.name === "backspace") { setSearchQuery(q => q.slice(0, -1)); return }
      if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) { setSearchQuery(q => q + key.sequence); return }
      return
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) { cleanup(); return }
    if (key.name === "up" || key.name === "k") { setSelectedIdx(i => Math.max(0, i - 1)); setPaused(true); return }
    if (key.name === "down" || key.name === "j") {
      setSelectedIdx(i => { const n = Math.min(filtered().length - 1, i + 1); if (n === filtered().length - 1) setPaused(false); return n })
      return
    }
    if (key.name === "return" || key.name === "space") {
      const ev = filtered()[selectedIdx()]
      if (ev) setExpandedIds(p => { const s = new Set<number>(p); s.has(ev.id) ? s.delete(ev.id) : s.add(ev.id); return s })
      return
    }
    if (key.sequence === "/" || key.name === "slash") { setSearchMode(true); setSearchQuery(""); return }
    if (key.name === "escape") { setSearchQuery(""); setSrcFilter(null); setEnabledLevels(new Set(LEVELS)); return }
    if (key.name === "l") { setShowLevelPicker(true); return }
    if (key.name === "v") { setShowColPicker(true); return }
    if (key.name === "tab") { const s = [null, ...names]; setSrcFilter(c => s[(s.indexOf(c) + 1) % s.length]); return }
    if (key.name === "c") { setEvents([]); setSelectedIdx(-1); setExpandedIds(new Set<number>()); eid = 0; return }
    if (key.name === "p") { setPaused(p => { if (p) setSelectedIdx(filtered().length - 1); return !p }); return }
    if (key.sequence === "G") { setSelectedIdx(filtered().length - 1); setPaused(false); return }
    if (key.sequence === "g") { setSelectedIdx(0); setPaused(true); return }
  })

  const levelItems = () => LEVELS.map((l, i) => ({ label: l, on: enabledLevels().has(l), key: String(i + 1), color: LEVEL_COLORS[l] }))
  const colItems = () => {
    const ids: ColId[] = ["time", "level", "source", "category", "message"]
    return ids.map((id, i) => ({ label: id, on: visibleCols().has(id), key: String(i + 1) }))
  }

  return (
    <box flexDirection="column" width={dims().width} height={dims().height} backgroundColor="#0d0d0d">
      <Header />
      <FilterBar />
      <ColHeaders />
      <box height={1}><text fg="#333">{"─".repeat(dims().width)}</text></box>
      <scrollbox flexGrow={1}>
        <For each={filtered()}>
          {(ev, i) => (
            <EventRow ev={ev} selected={i() === selectedIdx()} expanded={expandedIds().has(ev.id)} />
          )}
        </For>
      </scrollbox>
      <box height={1}><text fg="#333">{"─".repeat(dims().width)}</text></box>
      <Footer />
      <Show when={showLevelPicker()}><Overlay title="Log Levels" items={levelItems()} /></Show>
      <Show when={showColPicker()}><Overlay title="Columns" items={colItems()} /></Show>
    </box>
  )
}

// ── Main ────────────────────────────────────────────────────────────────────

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  screenMode: "alternate-screen",
  backgroundColor: "transparent",
  useMouse: true,
  autoFocus: true,
})

render(() => <App />, renderer)
setInterval(() => { setEps(recentCount); recentCount = 0 }, 1000)
spawnAll()
push("aires", "info", `Launched ${cmds.length} process(es): ${names.join(", ")}`)
