#!/usr/bin/env bun
/**
 * aires-dev — Development launcher with OpenTUI terminal interface
 *
 * Built on OpenTUI (yoga flexbox, native Zig renderer) + SolidJS.
 * Mouse-first UI: clickable rows, dropdown menus, hover states.
 * Keyboard shortcuts available as accelerators, not primary interaction.
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

const COL_DEFS: Array<{ id: ColId, label: string, width: number }> = [
  { id: "time", label: "Timestamp", width: 13 },
  { id: "level", label: "Level", width: 8 },
  { id: "source", label: "Source", width: 8 },
  { id: "category", label: "Category", width: 14 },
  { id: "message", label: "Message", width: 0 },
]

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
const [eps, setEps] = createSignal(0)

// Dropdown state — only one open at a time
const [openDropdown, setOpenDropdown] = createSignal<"levels" | "columns" | "source" | null>(null)
const [hoveredRow, setHoveredRow] = createSignal(-1)

let eid = 0
let recentCount = 0
const recentStructured = new Map<string, number>()

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
      ob += c.toString(); const ls = ob.split("\n"); ob = ls.pop()!
      for (const l of ls) handleLine(name, l, false)
    })
    child.stderr!.on("data", (c: Buffer) => {
      eb += c.toString(); const ls = eb.split("\n"); eb = ls.pop()!
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

function toggleInSet<T>(set: Set<T>, item: T): Set<T> {
  const next = new Set(set)
  next.has(item) ? next.delete(item) : next.add(item)
  return next
}

// ── Components ──────────────────────────────────────────────────────────────

function ToolbarButton(props: { label: string, active?: boolean, onMouseDown: (e: any) => void }) {
  const [hov, setHov] = createSignal(false)
  const bg = () => props.active ? "#2a2a2a" : hov() ? "#1a1a1a" : "transparent"
  return (
    <box
      height={1}
      paddingX={1}
      backgroundColor={bg()}
      onMouseDown={props.onMouseDown}
      onMouseOver={() => setHov(true)}
      onMouseOut={() => setHov(false)}
    >
      <text fg={props.active ? "#eab308" : "#888"}>{props.label}</text>
    </box>
  )
}

function SourcePill(props: { name: string, color: string, active: boolean, onMouseDown: (e: any) => void }) {
  const [hov, setHov] = createSignal(false)
  const bg = () => props.active ? "#1a1a1a" : hov() ? "#111" : "transparent"
  return (
    <box
      height={1}
      paddingX={1}
      backgroundColor={bg()}
      onMouseDown={props.onMouseDown}
      onMouseOver={() => setHov(true)}
      onMouseOut={() => setHov(false)}
    >
      <text fg={props.active ? props.color : "#555"}>{props.name}</text>
    </box>
  )
}

function Header() {
  return (
    <box flexDirection="row" height={1} paddingX={1} gap={1}>
      <text fg="#eab308">{"▓ Aires"}</text>
      <For each={names}>
        {(name, i) => (
          <SourcePill
            name={name}
            color={SRC_COLORS[i() % SRC_COLORS.length]}
            active={!srcFilter() || srcFilter() === name}
            onMouseDown={() => setSrcFilter(cur => cur === name ? null : name)}
          />
        )}
      </For>
      <box flexGrow={1} />
      <text fg="#555">{`${String(events().length)} events  ${String(eps())}/s`}</text>
      <Show when={paused()}>
        <box height={1} paddingX={1} backgroundColor="#332200" onMouseDown={() => setPaused(false)}>
          <text fg="#eab308">{"⏸ paused"}</text>
        </box>
      </Show>
    </box>
  )
}

function Toolbar() {
  return (
    <box flexDirection="row" height={1} paddingX={1} gap={0}>
      <ToolbarButton
        label={"▾ Levels"}
        active={openDropdown() === "levels"}
        onMouseDown={() => setOpenDropdown(d => d === "levels" ? null : "levels")}
      />
      <ToolbarButton
        label={"▾ Columns"}
        active={openDropdown() === "columns"}
        onMouseDown={() => setOpenDropdown(d => d === "columns" ? null : "columns")}
      />
      <ToolbarButton
        label={"▾ Source"}
        active={openDropdown() === "source"}
        onMouseDown={() => setOpenDropdown(d => d === "source" ? null : "source")}
      />
      <box flexGrow={1} />
      <Show when={srcFilter()}>
        <box height={1} paddingX={1} backgroundColor="#1a1a1a" onMouseDown={() => setSrcFilter(null)}>
          <text fg="#888">{`source: ${srcFilter()}  ✕`}</text>
        </box>
      </Show>
      <Show when={searchQuery() && !searchMode()}>
        <box height={1} paddingX={1} backgroundColor="#1a1a1a" onMouseDown={() => setSearchQuery("")}>
          <text fg="#888">{`search: ${searchQuery()}  ✕`}</text>
        </box>
      </Show>
      <Show when={searchMode()}>
        <box height={1} paddingX={1} backgroundColor="#1a1a1a">
          <text fg="#eab308">{`/ ${searchQuery()}▌`}</text>
        </box>
      </Show>
    </box>
  )
}

function ColHeaders() {
  const cols = visibleCols()
  return (
    <box flexDirection="row" height={1} paddingX={1}>
      <For each={COL_DEFS.filter(c => cols.has(c.id))}>
        {(col) => (
          <box width={col.width || undefined} flexGrow={col.width === 0 ? 1 : undefined}>
            <text fg="#555">{col.label}</text>
          </box>
        )}
      </For>
    </box>
  )
}

function EventRow(props: { ev: Ev, idx: number, selected: boolean, expanded: boolean }) {
  const cols = visibleCols()
  const si = names.indexOf(props.ev.src)
  const srcColor = si >= 0 ? SRC_COLORS[si % SRC_COLORS.length] : "#666"
  const levelColor = LEVEL_COLORS[props.ev.level] || "#666"

  const msgColor = () => {
    if (props.ev.level === "error" || props.ev.level === "fatal") return LEVEL_COLORS[props.ev.level]
    if (props.ev.level === "warn") return "#eab308"
    if (props.ev.level === "stdout" || props.ev.level === "stderr") return "#888"
    return "#e5e5e5"
  }

  const isHovered = () => hoveredRow() === props.idx
  const bg = () => props.selected ? "#2a2a2a" : isHovered() ? "#1a1a1a" : "transparent"

  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        height={1}
        paddingX={1}
        backgroundColor={bg()}
        onMouseDown={() => {
          if (selectedIdx() === props.idx) {
            setExpandedIds(p => toggleInSet(p, props.ev.id))
          } else {
            setSelectedIdx(props.idx)
            setPaused(true)
          }
        }}
        onMouseOver={() => setHoveredRow(props.idx)}
        onMouseOut={() => { if (hoveredRow() === props.idx) setHoveredRow(-1) }}
      >
        <Show when={cols.has("time")}>
          <box width={13}><text fg="#666">{fmtTime(props.ev.ts)}</text></box>
        </Show>
        <Show when={cols.has("level")}>
          <box width={8}><text fg={levelColor}>{props.ev.level}</text></box>
        </Show>
        <Show when={cols.has("source")}>
          <box width={8}><text fg={srcColor}>{props.ev.src}</text></box>
        </Show>
        <Show when={cols.has("category")}>
          <box width={14}><text fg="#777">{props.ev.cat}</text></box>
        </Show>
        <Show when={cols.has("message")}>
          <box flexGrow={1}><text fg={msgColor()}>{props.ev.msg}</text></box>
        </Show>
      </box>
      <Show when={props.expanded}>
        <For each={Object.entries(props.ev.attrs).filter(([k]) => k !== "_metric" && k !== "_metricValue")}>
          {([key, val]) => (
            <box flexDirection="row" height={1} paddingLeft={4}>
              <box width={16}><text fg="#666">{key}</text></box>
              <box flexGrow={1}><text fg="#aaa">{typeof val === "string" ? val : JSON.stringify(val)}</text></box>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

function DropdownItem(props: { label: string, checked: boolean, color?: string, onMouseDown: (e: any) => void }) {
  const [hov, setHov] = createSignal(false)
  return (
    <box
      flexDirection="row"
      height={1}
      paddingX={1}
      backgroundColor={hov() ? "#2a2a2a" : "transparent"}
      onMouseDown={props.onMouseDown}
      onMouseOver={() => setHov(true)}
      onMouseOut={() => setHov(false)}
    >
      <box width={3}><text fg={props.checked ? "#22c55e" : "#444"}>{props.checked ? "✓" : " "}</text></box>
      <text fg={props.color || "#ccc"}>{props.label}</text>
    </box>
  )
}

function LevelsDropdown() {
  return (
    <box position="absolute" left={1} top={2} width={24} flexDirection="column" border borderStyle="rounded" backgroundColor="#111" padding={0}>
      <box height={1} paddingX={1}><text fg="#888">{"Filter levels"}</text></box>
      <For each={LEVELS}>
        {(level) => (
          <DropdownItem
            label={level}
            checked={enabledLevels().has(level)}
            color={LEVEL_COLORS[level]}
            onMouseDown={(e: any) => { e.stopPropagation(); setEnabledLevels(prev => toggleInSet(prev, level)) }}
          />
        )}
      </For>
      <box height={1} paddingX={1} onMouseDown={(e: any) => { e.stopPropagation(); setEnabledLevels(new Set(LEVELS)) }}>
        <text fg="#555">{"reset all"}</text>
      </box>
    </box>
  )
}

function ColumnsDropdown() {
  return (
    <box position="absolute" left={10} top={2} width={24} flexDirection="column" border borderStyle="rounded" backgroundColor="#111" padding={0}>
      <box height={1} paddingX={1}><text fg="#888">{"Visible columns"}</text></box>
      <For each={COL_DEFS}>
        {(col) => (
          <DropdownItem
            label={col.label}
            checked={visibleCols().has(col.id)}
            onMouseDown={(e: any) => { e.stopPropagation(); setVisibleCols(prev => toggleInSet(prev, col.id)) }}
          />
        )}
      </For>
    </box>
  )
}

function SourceDropdown() {
  return (
    <box position="absolute" left={20} top={2} width={24} flexDirection="column" border borderStyle="rounded" backgroundColor="#111" padding={0}>
      <box height={1} paddingX={1}><text fg="#888">{"Filter by source"}</text></box>
      <DropdownItem
        label={"all sources"}
        checked={!srcFilter()}
        onMouseDown={(e: any) => { e.stopPropagation(); setSrcFilter(null); setOpenDropdown(null) }}
      />
      <For each={names}>
        {(name, i) => (
          <DropdownItem
            label={name}
            checked={srcFilter() === name}
            color={SRC_COLORS[i() % SRC_COLORS.length]}
            onMouseDown={(e: any) => { e.stopPropagation(); setSrcFilter(name); setOpenDropdown(null) }}
          />
        )}
      </For>
    </box>
  )
}

function Footer() {
  return (
    <box flexDirection="row" height={1} paddingX={1}>
      <text fg="#444">{"↑↓ scroll  ⏎ expand  / search  esc clear  q quit"}</text>
      <box flexGrow={1} />
      <text fg="#555">{`${String(filtered().length)} / ${String(events().length)}`}</text>
    </box>
  )
}

// ── Root App ────────────────────────────────────────────────────────────────

function App() {
  const dims = useTerminalDimensions()

  useKeyboard((key) => {
    // Close dropdown on any key
    if (openDropdown()) {
      setOpenDropdown(null)
      return
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
      if (ev) setExpandedIds(p => toggleInSet(p, ev.id))
      return
    }
    if (key.sequence === "/" || key.name === "slash") { setSearchMode(true); setSearchQuery(""); return }
    if (key.name === "escape") { setSearchQuery(""); setSrcFilter(null); setEnabledLevels(new Set(LEVELS)); return }
    if (key.name === "c") { setEvents([]); setSelectedIdx(-1); setExpandedIds(new Set<number>()); eid = 0; return }
    if (key.name === "p") { setPaused(p => { if (p) setSelectedIdx(filtered().length - 1); return !p }); return }
    if (key.sequence === "G") { setSelectedIdx(filtered().length - 1); setPaused(false); return }
    if (key.sequence === "g") { setSelectedIdx(0); setPaused(true); return }
  })

  return (
    <box flexDirection="column" width={dims().width} height={dims().height} backgroundColor="#0d0d0d">
      <Header />
      <Toolbar />
      <ColHeaders />
      <box height={1}><text fg="#222">{"─".repeat(dims().width)}</text></box>
      <scrollbox flexGrow={1}>
        <For each={filtered()}>
          {(ev, i) => (
            <EventRow ev={ev} idx={i()} selected={i() === selectedIdx()} expanded={expandedIds().has(ev.id)} />
          )}
        </For>
      </scrollbox>
      <box height={1}><text fg="#222">{"─".repeat(dims().width)}</text></box>
      <Footer />

      {/* Dropdown backdrop — click anywhere to close */}
      <Show when={openDropdown()}>
        <box
          position="absolute"
          left={0} top={0}
          width={dims().width}
          height={dims().height}
          onMouseDown={() => setOpenDropdown(null)}
        />
      </Show>

      {/* Dropdown menus */}
      <Show when={openDropdown() === "levels"}><LevelsDropdown /></Show>
      <Show when={openDropdown() === "columns"}><ColumnsDropdown /></Show>
      <Show when={openDropdown() === "source"}><SourceDropdown /></Show>
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
