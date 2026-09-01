import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LogStream } from '@/lib/logStreamStore'

interface LogConsoleProps {
  /** The lines and connection state to render. Where they come from is the
   *  caller's business — a log panel's binding, or the pre-grid drawer. */
  stream: LogStream
  /** Names the container being streamed. Null keeps the label out entirely. */
  label?: string | null
  /** Chrome belonging to the caller, placed first in the header row — the
   *  pre-grid console's collapse toggle. */
  leading?: ReactNode
}

/**
 * The log console itself: the filter, the pause/live toggle, the auto-follow
 * and the line colouring, over whatever stream it is handed.
 *
 * It is deliberately free of any connection logic. The socket belongs to
 * `LogStreamStore`, shared per engine endpoint, so two consoles on one engine
 * cost one connection and can still be filtered and paused independently —
 * filtering and pausing are viewport state, not stream state.
 *
 * Fills its container, with only the line area scrolling, so it sits equally in
 * a fixed-height drawer and in a grid panel the operator sized.
 */
export function LogConsole({ stream, label = null, leading }: LogConsoleProps) {
  const { status, lines } = stream
  const [autoScroll, setAutoScroll] = useState(true)
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const [excludeMode, setExcludeMode] = useState(false)
  const filterRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Auto-scroll when new lines arrive (only if not paused)
  useEffect(() => {
    if (autoScroll && !paused && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [lines, autoScroll, paused])

  const handleScroll = () => {
    if (!containerRef.current) return
    const el = containerRef.current
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    setAutoScroll(atBottom)
  }

  // Filtered log lines — computed from the full buffer
  const filteredLogs = useMemo(() => {
    if (!filter.trim()) return lines
    const lower = filter.toLowerCase()
    return excludeMode
      ? lines.filter((line) => !line.toLowerCase().includes(lower))
      : lines.filter((line) => line.toLowerCase().includes(lower))
  }, [lines, filter, excludeMode])

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

  return (
    <div
      onKeyDown={handleKeyDown}
      // Inline rather than `h-full`: the console renders in the browser test
      // project too, which runs no Tailwind build (same rule as GridPage).
      style={{ height: '100%' }}
      className="flex flex-col min-h-0 min-w-0 rounded-md border border-white/[0.04] overflow-hidden"
    >
      {/* Header bar */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-1 bg-[#111115] flex-wrap">
        {leading}

        {/* Connection indicator */}
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            status === 'connected'
              ? 'bg-[#76B900]'
              : status === 'reconnecting'
                ? 'bg-yellow-400'
                : 'bg-zinc-500'
          }`}
          title={status}
        />

        {/* Which engine's container is being streamed */}
        {label && (
          <span className="text-[10px] text-zinc-600 truncate max-w-[240px] shrink-0">{label}</span>
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
          {filteredLogs.length}/{lines.length}
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
      <div className="shrink-0 flex items-center gap-2 px-2 py-1 bg-[#0d0d11] border-y border-white/[0.04]">
        <button
          onClick={() => setExcludeMode(!excludeMode)}
          className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 border transition-colors ${
            excludeMode
              ? 'bg-red-500/15 text-red-400 border-red-500/30'
              : 'bg-blue-500/15 text-blue-400 border-blue-500/30'
          }`}
          title={
            excludeMode
              ? 'Exclude mode — hides matching lines'
              : 'Filter mode — shows only matching lines'
          }
        >
          {excludeMode ? 'Exclude' : 'Filter'}
        </button>
        <svg
          className="w-3 h-3 text-zinc-500 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
          />
        </svg>
        <input
          ref={filterRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={excludeMode ? 'Exclude lines containing...' : 'Filter lines containing...'}
          className="flex-1 min-w-0 bg-transparent text-[11px] text-zinc-300 placeholder-zinc-600 outline-none border-none"
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
        className={`flex-1 min-h-0 overflow-y-auto bg-black/60
                   font-mono text-[11px] leading-[1.4] p-2 space-y-0.5 ${paused ? 'opacity-60' : ''}`}
      >
        {lines.length === 0 && <EmptyStream status={status} />}

        {filteredLogs.length === 0 && lines.length > 0 && (
          <div className="text-zinc-600 italic text-center pt-8">
            No lines match &quot;{filter}&quot;
          </div>
        )}

        {filteredLogs.map((line, i) => {
          const isError =
            line.toLowerCase().includes('error') || line.toLowerCase().includes('traceback')
          const isWarning =
            line.toLowerCase().includes('warn') || line.toLowerCase().includes('warning')
          return (
            <div
              key={i}
              className={`whitespace-pre-wrap break-all ${
                isError ? 'text-red-400' : isWarning ? 'text-yellow-400' : 'text-zinc-300'
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

/**
 * What a console with no lines says. `unavailable` is the one that has to name
 * itself as a deployment choice: the backend registers `/ws/logs` only when it
 * is started with the flag, so nothing about the panel is broken and there is
 * nothing to retry — there is a server to restart with one more argument.
 */
function EmptyStream({ status }: { status: LogStream['status'] }) {
  return (
    <div className="text-zinc-600 italic text-center pt-8">
      {status === 'connected' && 'Waiting for log output...'}
      {status === 'connecting' && 'Connecting...'}
      {status === 'reconnecting' && 'Connection lost — reconnecting…'}
      {status === 'unavailable' &&
        'Log viewer not enabled on this server — start the dashboard with --enable-log-viewer (or SPARK_DASHBOARD_ENABLE_LOG_VIEWER=1).'}
    </div>
  )
}
