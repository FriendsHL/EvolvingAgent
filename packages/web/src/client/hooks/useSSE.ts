import { useState, useEffect, useRef } from 'react'

export function useSSE<T>(url: string) {
  const [events, setEvents] = useState<T[]>([])
  const [connected, setConnected] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const source = new EventSource(url)
    sourceRef.current = source

    source.onopen = () => setConnected(true)
    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as T
        setEvents((prev) => [...prev.slice(-99), data])
      } catch { /* ignore parse errors */ }
    }
    source.onerror = () => setConnected(false)

    return () => {
      source.close()
      sourceRef.current = null
    }
  }, [url])

  return { events, connected }
}
