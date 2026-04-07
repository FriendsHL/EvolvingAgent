import { useState, useEffect, useRef, useCallback } from 'react'

export interface UseSSEOptions {
  /** Maximum events to retain in memory (FIFO eviction). Default 200. */
  capacity?: number
  /** Start in paused state — events will be discarded until resume(). */
  startPaused?: boolean
}

export interface UseSSEResult<T> {
  events: T[]
  connected: boolean
  paused: boolean
  pause: () => void
  resume: () => void
  clear: () => void
  /** Total events received (including those evicted by capacity). */
  totalReceived: number
}

/**
 * Subscribe to a Server-Sent-Events endpoint.
 *
 * Used by the global event stream page (D1) and the per-session live tab in
 * SessionDetailPage (D2). Both consumers share the same hook so we have a
 * single place to tune capacity / pause / reconnect behavior.
 */
export function useSSE<T>(url: string, options: UseSSEOptions = {}): UseSSEResult<T> {
  const capacity = options.capacity ?? 200
  const [events, setEvents] = useState<T[]>([])
  const [connected, setConnected] = useState(false)
  const [paused, setPaused] = useState(options.startPaused ?? false)
  const [totalReceived, setTotalReceived] = useState(0)

  // Use refs so the EventSource handler reads the *current* paused flag
  // without needing to be re-attached every time the user toggles pause.
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const source = new EventSource(url)
    sourceRef.current = source

    source.onopen = () => setConnected(true)
    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as T
        setTotalReceived((n) => n + 1)
        if (pausedRef.current) return
        setEvents((prev) => {
          const next = prev.length >= capacity ? prev.slice(prev.length - capacity + 1) : prev
          return [...next, data]
        })
      } catch { /* ignore parse errors */ }
    }
    source.onerror = () => setConnected(false)

    return () => {
      source.close()
      sourceRef.current = null
    }
  }, [url, capacity])

  const pause = useCallback(() => setPaused(true), [])
  const resume = useCallback(() => setPaused(false), [])
  const clear = useCallback(() => setEvents([]), [])

  return { events, connected, paused, pause, resume, clear, totalReceived }
}
