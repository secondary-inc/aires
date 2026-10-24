// Aires query client — fetches & tails events from the collector's HTTP
// query API. Pure fetch/SSE, no native bindings required.
//
// Usage:
//
//   import { query } from "@aires/sdk"
//
//   const client = query.client({
//     endpoint: "http://collector.aires.svc.cluster.local:4318",
//     token: process.env.AIRES_QUERY_TOKEN,
//   })
//
//   const events = await client.search({ service: "ws-foo", limit: 100 })
//
//   for await (const event of client.tail({ service: "ws-foo" })) {
//     console.log(event.message)
//   }
//
// Minting (typically at startup, cached):
//
//   const { token } = await query.mint({
//     endpoint: "http://collector.aires.svc.cluster.local:4318",
//     rootKey: process.env.AIRES_ROOT_KEY,
//     scope: ["ws-*", "int-*"],
//     ttlHours: 24,
//   })

export type QueryEvent = {
  timestamp: string
  service: string
  severity: string
  message: string
  trace_id: string
  attributes: Record<string, string>
  kind: string
  http_method?: string
  http_path?: string
  http_status_code?: number
  http_duration_ms?: number
  error_type?: string
  error_message?: string
}

export type SearchParams = {
  service?: string
  level?: string
  from?: string | Date
  to?: string | Date
  messageContains?: string
  traceId?: string
  limit?: number
}

export type TailParams = {
  service?: string
  level?: string
  since?: string | Date
  intervalMs?: number
  limit?: number
  signal?: AbortSignal
}

export type MintParams = {
  endpoint: string
  rootKey: string
  scope: string[]
  ttlHours: number
}

export type MintResult = {
  token: string
  exp: number
}

export type ClientOptions = {
  endpoint: string
  token: string
}

// ── Top-level helpers ───────────────────────────────────────────────────────

const normalizeDate = (v: string | Date | undefined): string | undefined => {
  if (!v) return undefined
  return typeof v === "string" ? v : v.toISOString()
}

const serializeSearch = (params: SearchParams): Record<string, unknown> => ({
  service: params.service,
  level: params.level,
  from: normalizeDate(params.from),
  to: normalizeDate(params.to),
  message_contains: params.messageContains,
  trace_id: params.traceId,
  limit: params.limit,
})

// ── Minting ─────────────────────────────────────────────────────────────────

export const mint = async (params: MintParams): Promise<MintResult> => {
  const res = await fetch(`${params.endpoint.replace(/\/$/, "")}/auth/mint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      root_key: params.rootKey,
      scope: params.scope,
      ttl_hours: params.ttlHours,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`aires.query.mint failed: ${res.status} ${body}`)
  }

  return (await res.json()) as MintResult
}

// ── Client ──────────────────────────────────────────────────────────────────

export type Client = {
  search: (params: SearchParams) => Promise<QueryEvent[]>
  tail: (params: TailParams) => AsyncIterable<QueryEvent>
}

export const client = (opts: ClientOptions): Client => {
  const base = opts.endpoint.replace(/\/$/, "")
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.token}`,
  }

  const search = async (params: SearchParams): Promise<QueryEvent[]> => {
    const res = await fetch(`${base}/query/search`, {
      method: "POST",
      headers,
      body: JSON.stringify(serializeSearch(params)),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`aires.query.search failed: ${res.status} ${body}`)
    }
    const data = (await res.json()) as { events: QueryEvent[] }
    return data.events
  }

  const tail = (params: TailParams): AsyncIterable<QueryEvent> => ({
    [Symbol.asyncIterator]: () => tailIterator(base, headers, params),
  })

  return { search, tail }
}

// ── SSE tail iterator ───────────────────────────────────────────────────────

const tailIterator = (
  base: string,
  headers: Record<string, string>,
  params: TailParams,
): AsyncIterator<QueryEvent> => {
  let buffered: QueryEvent[] = []
  let done = false
  // Use only the standard operations required here. Bun adds readMany to its
  // global reader type, but fetch may expose a standards-only reader.
  let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel"> | null = null
  let leftover = ""
  const decoder = new TextDecoder()
  let initPromise: Promise<void> | null = null

  const init = async () => {
    const res = await fetch(`${base}/query/tail`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        service: params.service,
        level: params.level,
        since: normalizeDate(params.since),
        interval_ms: params.intervalMs,
        limit: params.limit,
      }),
      signal: params.signal,
    })
    if (!res.ok || !res.body) {
      const body = res.body ? await res.text() : ""
      throw new Error(`aires.query.tail failed: ${res.status} ${body}`)
    }
    reader = res.body.getReader()
  }

  const readChunk = async (): Promise<QueryEvent[]> => {
    if (!reader) return []
    const { value, done: finished } = await reader.read()
    if (finished) {
      done = true
      return []
    }
    leftover += decoder.decode(value, { stream: true })

    const events: QueryEvent[] = []
    let idx: number
    // SSE messages separated by blank line
    while ((idx = leftover.indexOf("\n\n")) !== -1) {
      const frame = leftover.slice(0, idx)
      leftover = leftover.slice(idx + 2)
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          const payload = line.slice(6)
          try {
            events.push(JSON.parse(payload) as QueryEvent)
          } catch {
            // ignore malformed
          }
        }
        // `:keepalive` / `event: error` etc. ignored
      }
    }
    return events
  }

  return {
    async next(): Promise<IteratorResult<QueryEvent>> {
      if (!initPromise) initPromise = init()
      await initPromise

      while (buffered.length === 0 && !done) {
        try {
          const chunk = await readChunk()
          buffered.push(...chunk)
        } catch (err) {
          if (params.signal?.aborted) {
            done = true
            return { value: undefined, done: true }
          }
          throw err
        }
      }

      if (buffered.length === 0 && done) {
        return { value: undefined, done: true }
      }

      return { value: buffered.shift()!, done: false }
    },

    async return(): Promise<IteratorResult<QueryEvent>> {
      done = true
      try {
        reader?.cancel()
      } catch {
        // ignore
      }
      return { value: undefined, done: true }
    },
  }
}
