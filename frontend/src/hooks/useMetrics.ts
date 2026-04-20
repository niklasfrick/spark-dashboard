import { useState, useEffect, useRef, useCallback } from 'react'
import type { MetricsSnapshot } from '../types/metrics'

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected'

export function useMetrics() {
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [isStale, setIsStale] = useState(false)
  const lastMessageTime = useRef<number>(0)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef = useRef(0)
  const pendingRef = useRef<MetricsSnapshot | null>(null)
  const initialFlushDone = useRef(false)

  const connect = useCallback(() => {
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setConnectionStatus('connected')
      attemptRef.current = 0
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as MetricsSnapshot
        lastMessageTime.current = Date.now()
        pendingRef.current = data
        // Render the very first snapshot immediately so the UI isn't blank
        if (!initialFlushDone.current) {
          initialFlushDone.current = true
          setMetrics(data)
          pendingRef.current = null
          setIsStale(false)
        }
      } catch { /* ignore parse errors */ }
    }

    ws.onclose = () => {
      wsRef.current = null
      setConnectionStatus('reconnecting')
      const delay = Math.min(1000 * Math.pow(2, attemptRef.current), 10000)
      attemptRef.current++
      reconnectTimeout.current = setTimeout(connect, delay)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      wsRef.current?.close()
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current)
    }
  }, [connect])

  // Periodic flush: push the latest pending snapshot into React state.
  // Skips when the tab is hidden so the browser can fully throttle the page.
  useEffect(() => {
    function flush() {
      if (document.hidden) return
      if (pendingRef.current) {
        setMetrics(pendingRef.current)
        pendingRef.current = null
        setIsStale(false)
      } else if (connectionStatus === 'connected' && lastMessageTime.current > 0) {
        setIsStale(Date.now() - lastMessageTime.current > 5000)
      }
    }

    // When the tab becomes visible again, flush immediately
    function onVisible() {
      if (!document.hidden) flush()
    }

    const id = setInterval(flush, 2000)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [connectionStatus])

  return { metrics, connectionStatus, isStale }
}
