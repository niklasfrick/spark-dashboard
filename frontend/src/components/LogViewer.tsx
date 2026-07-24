import { useState, useEffect, useRef, useMemo } from 'react'

/**
 * Scrollable log viewer that connects to the backend's /ws/logs WebSocket
 * endpoint and streams Docker container logs in real-time.
 *
 * Features:
 * - Collapsible section at the bottom of the dashboard
 * - Pause/Resume button — freeze the viewport to read, unpause to catch up
 * - Text filter — type a keyword to only show lines containing it
 * - Auto-scroll to newest lines (pauses when scrolled up manually)
 * - Error/warning color highlighting
 */
export function LogViewer({ onExpandChange }: { onExpandChange?: (expanded: boolean) => void }) {
  const [logs, setLogs] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [collapsed, setCollapsed] = useState(true)
  const [autoScroll, setAutoScroll] = useState(true)
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const [excludeMode, setExcludeMode] = useState(false)
  const filterRef = useRef<HTMLInputElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/logs`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
    }

    ws.onmessage = (event) => {
      const text = event.data as string
      setLogs((prev) => {
        const next = [...prev, text]
        return next.length > 1000 ? next.slice(-1000) : next
      })
    }

    ws.onclose = () => {
      setConnected(false)
      wsRef.current = null
    }

    ws.onerror = () => {
      ws.close()
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [])

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
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${connected ? 'bg-[#76B900]' : 'bg-zinc-500'}`} />
          Console Logs
          <span className="text-zinc-600 ml-auto">
            {connected ? '● Live' : '○ Disconnected'}
          </span>
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
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${connected ? 'bg-[#76B900]' : 'bg-zinc-500'}`} />

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

      {/* Log content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className={`h-48 overflow-y-auto bg-black/60 rounded-b-md border border-white/[0.04] 
                   font-mono text-[11px] leading-[1.4] p-2 space-y-0.5 ${paused ? 'opacity-60' : ''}`}
        style={{ scrollBehavior: 'smooth' }}
      >
        {logs.length === 0 && (
          <div className="text-zinc-600 italic text-center pt-8">
            {connected ? 'Waiting for log output...' : 'Connecting...'}
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
