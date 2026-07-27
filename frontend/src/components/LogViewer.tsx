import { useState, useEffect, useRef, useMemo } from 'react'
import type { EngineSnapshot } from '../types/metrics'

/**
 * Scrollable log viewer that connects to the backend's /ws/logs WebSocket
 * endpoint and streams Docker container logs in real-time.
 *
 * The stream follows the engine selected in the engine section: when an
 * engine tab is active its endpoint is passed as `?engine=` so the backend
 * streams that engine's container; on the Global tab the first Docker engine
 * is used (mirroring the backend's default). Switching engines reconnects
 * and clears the buffer — the old lines belong to another container.
 *
 * Features:
 * - Collapsible section at the bottom of the dashboard
 * - Pause/Resume button — freeze the viewport to read, unpause to catch up
 * - Text filter — type a keyword to only show lines containing it
 * - Auto-scroll to newest lines (pauses when scrolled up manually)
 * - Error/warning color highlighting
 */
interface LogViewerProps {
  /** Engine snapshots from the current metrics payload. */
  engines?: EngineSnapshot[]
  /** Endpoint of the engine tab selected in the engine section; null on the
   *  Global tab. */
  selectedEndpoint?: string | null
  onExpandChange?: (expanded: boolean) => void
}

/** Connection lifecycle of the log socket. `idle` while collapsed (lazy
 *  connect); `unavailable` when the handshake never succeeds — the backend
 *  runs without --enable-log-viewer, so /ws/logs is not registered. */
type LogConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable'

export function LogViewer({ engines = [], selectedEndpoint = null, onExpandChange }: LogViewerProps) {
  const [logs, setLogs] = useState<string[]>([])
  const [connState, setConnState] = useState<LogConnState>('idle')
  const connected = connState === 'connected'
  const [collapsed, setCollapsed] = useState(true)
  const [autoScroll, setAutoScroll] = useState(true)
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const [excludeMode, setExcludeMode] = useState(false)
  const filterRef = useRef<HTMLInputElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Engine whose container is streamed: the selected tab's engine when one is
  // active and still present, otherwise the first Docker engine (the backend
  // applies the same default when no ?engine= is passed).
  const targetEndpoint = useMemo(() => {
    if (selectedEndpoint && engines.some((e) => e.endpoint === selectedEndpoint)) {
      return selectedEndpoint
    }
    return engines.find((e) => e.deployment_mode === 'Docker')?.endpoint ?? null
  }, [engines, selectedEndpoint])

  const targetEngine = engines.find((e) => e.endpoint === targetEndpoint)
  const engineLabel = targetEngine
    ? (targetEngine.model?.name ?? targetEngine.endpoint)
    : null

  // Identity of the connection the buffer belongs to: null while collapsed (no
  // socket at all), otherwise the container being streamed.
  const connectionKey = collapsed ? null : (targetEndpoint ?? '')
  const [prevConnectionKey, setPrevConnectionKey] = useState<string | null>(null)

  // Connecting fresh or to a different container: drop the previous lines. The
  // buffer is derived from the connection identity, so it is reset during
  // render — resetting it synchronously inside the socket effect below would
  // paint one frame of the previous container's logs under the new label.
  if (prevConnectionKey !== connectionKey) {
    setPrevConnectionKey(connectionKey)
    if (connectionKey !== null) {
      setLogs([])
      setConnState('connecting')
    }
  }

  useEffect(() => {
    // Lazy connect: no socket (and no backend Docker stream) until the console
    // is first expanded. Collapsing tears the socket down again, which also
    // lets the backend stop the container stream once its last viewer leaves.
    if (collapsed) return

    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let everOpened = false

    const connect = () => {
      if (disposed) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const query = targetEndpoint ? `?engine=${encodeURIComponent(targetEndpoint)}` : ''
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/logs${query}`)
      wsRef.current = ws

      ws.onopen = () => {
        everOpened = true
        setConnState('connected')
      }

      ws.onmessage = (event) => {
        const text = event.data as string
        setLogs((prev) => {
          const next = [...prev, text]
          return next.length > 1000 ? next.slice(-1000) : next
        })
      }

      ws.onclose = () => {
        wsRef.current = null
        if (disposed) return
        if (!everOpened) {
          // Handshake never succeeded: /ws/logs is not registered (backend
          // without --enable-log-viewer) or the server is unreachable. Don't
          // retry a doomed endpoint; the next expand or engine switch retries.
          setConnState('unavailable')
          return
        }
        // Live connection dropped (backend restart, network): retry with a
        // delay, like the metrics socket does.
        setConnState('reconnecting')
        retryTimer = setTimeout(connect, 2000)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      wsRef.current?.close()
      wsRef.current = null
      setConnState('idle')
    }
  }, [collapsed, targetEndpoint])

  // Auto-scroll when new logs arrive (only if not paused)
  useEffect(() => {
    if (autoScroll && !paused && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs, autoScroll, paused])

  const handleScroll = () => {
    if (!containerRef.current) return
    const el = containerRef.current
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    setAutoScroll(atBottom)
  }

  // Filtered log lines — computed from the full buffer
  const filteredLogs = useMemo(() => {
    if (!filter.trim()) return logs
    const lower = filter.toLowerCase()
    return excludeMode
      ? logs.filter((line) => !line.toLowerCase().includes(lower))
      : logs.filter((line) => line.toLowerCase().includes(lower))
  }, [logs, filter, excludeMode])

  // Toggle pause/resume
  const togglePause = () => {
    const next = !paused
    setPaused(next)
    if (!next) {
      // Unpausing: jump to bottom
      setAutoScroll(true)
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight
      }
    }
  }

  // Keyboard shortcut: Ctrl+F / Cmd+F to focus the filter input
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault()
      filterRef.current?.focus()
    }
  }

  if (collapsed) {
    return (
      <div className="shrink-0 mt-2">
        <button
          onClick={() => { setCollapsed(false); onExpandChange?.(true) }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-zinc-400 
                     bg-[#111115] rounded-md border border-white/[0.04] hover:border-zinc-700 
                     transition-colors duration-200"
        >
          ▶ Console Logs
          {engineLabel && (
            <span className="text-[10px] text-zinc-600 truncate max-w-[240px]">
              {engineLabel}
            </span>
          )}
          <span className="text-zinc-600 ml-auto">click to stream</span>
        </button>
      </div>
    )
  }

  return (
    <div className="shrink-0 mt-2" onKeyDown={handleKeyDown}>
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#111115] rounded-t-md border border-white/[0.04] border-b-0 flex-wrap">
        <button
          onClick={() => { setCollapsed(true); onExpandChange?.(false) }}
          className="text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors shrink-0"
        >
          ▼ Console Logs
        </button>

        {/* Connection indicator */}
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            connected
              ? 'bg-[#76B900]'
              : connState === 'reconnecting'
                ? 'bg-yellow-400'
                : 'bg-zinc-500'
          }`}
          title={connState}
        />

        {/* Which engine's container is being streamed */}
        {engineLabel && (
          <span className="text-[10px] text-zinc-600 truncate max-w-[240px] shrink-0">
            {engineLabel}
          </span>
        )}

        {/* Pause/Resume button */}
        <button
          onClick={togglePause}
          className={`text-[11px] px-2 py-0.5 rounded font-medium transition-colors shrink-0 ${
            paused
              ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
          title={paused ? 'Resume — jump to latest' : 'Pause — freeze viewport'}
        >
          {paused ? '⏸ Paused' : '⏵ Live'}
        </button>

        {/* Line count */}
        <span className="text-[10px] text-zinc-600 shrink-0">
          {filteredLogs.length}/{logs.length}
        </span>

        {/* Scroll-to-bottom button (only when not auto-scrolling) */}
        {!autoScroll && !paused && (
          <button
            onClick={() => {
              setAutoScroll(true)
              if (containerRef.current) {
                containerRef.current.scrollTop = containerRef.current.scrollHeight
              }
            }}
            className="text-[10px] text-yellow-400 hover:text-yellow-300 shrink-0"
          >
            ↓ Auto-scroll
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 px-3 py-1 bg-[#0d0d11] border-x border-white/[0.04]">
        <button
          onClick={() => setExcludeMode(!excludeMode)}
          className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 border transition-colors ${
            excludeMode
              ? 'bg-red-500/15 text-red-400 border-red-500/30'
              : 'bg-blue-500/15 text-blue-400 border-blue-500/30'
          }`}
          title={excludeMode ? 'Exclude mode — hides matching lines' : 'Filter mode — shows only matching lines'}
        >
          {excludeMode ? 'Exclude' : 'Filter'}
        </button>
        <svg className="w-3 h-3 text-zinc-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <input
          ref={filterRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={excludeMode ? 'Exclude lines containing...' : 'Filter lines containing...'}
          className="flex-1 bg-transparent text-[11px] text-zinc-300 placeholder-zinc-600 outline-none border-none"
        />
        {filter && (
          <button
            onClick={() => setFilter('')}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 shrink-0"
          >
            ✕
          </button>
        )}
      </div>

      {/* Log content. Auto-follow must jump instantly: with smooth scrolling
        * every appended line animates toward the bottom, and the scroll events
        * fired mid-animation read as "not at bottom", flickering autoScroll
        * (and the resume button) off and on with each batch. */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className={`h-48 overflow-y-auto bg-black/60 rounded-b-md border border-white/[0.04]
                   font-mono text-[11px] leading-[1.4] p-2 space-y-0.5 ${paused ? 'opacity-60' : ''}`}
      >
        {logs.length === 0 && (
          <div className="text-zinc-600 italic text-center pt-8">
            {connState === 'connected' && 'Waiting for log output...'}
            {(connState === 'connecting' || connState === 'idle') && 'Connecting...'}
            {connState === 'reconnecting' && 'Connection lost — reconnecting…'}
            {connState === 'unavailable' &&
              'Log viewer not enabled on this server — start the dashboard with --enable-log-viewer (or SPARK_DASHBOARD_ENABLE_LOG_VIEWER=1).'}
          </div>
        )}

        {filteredLogs.length === 0 && logs.length > 0 && (
          <div className="text-zinc-600 italic text-center pt-8">
            No lines match &quot;{filter}&quot;
          </div>
        )}

        {filteredLogs.map((line, i) => {
          const isError = line.toLowerCase().includes('error') || line.toLowerCase().includes('traceback')
          const isWarning = line.toLowerCase().includes('warn') || line.toLowerCase().includes('warning')
          return (
            <div
              key={i}
              className={`whitespace-pre-wrap break-all ${
                isError
                  ? 'text-red-400'
                  : isWarning
                    ? 'text-yellow-400'
                    : 'text-zinc-300'
              }`}
            >
              {line}
            </div>
          )
        })}
      </div>
    </div>
  )
}
