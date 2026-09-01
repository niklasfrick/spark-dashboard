import { useMemo, useState } from 'react'
import { useLogStream } from '../hooks/useLogStream'
import { findEngineByEndpoint } from '../lib/identity'
import { LogConsole } from './LogConsole'
import type { EngineSnapshot } from '../types/metrics'

/**
 * The pre-grid dashboard's log drawer: a collapsible console at the foot of the
 * page, streaming one engine's container logs.
 *
 * The stream follows the engine selected in the engine section: when an engine
 * tab is active its endpoint is streamed; on the Global tab the first Docker
 * engine is used (mirroring the backend's default). Switching engines switches
 * streams — the old lines belong to another container.
 *
 * The connection itself belongs to `LogStreamStore`, shared per endpoint with
 * the log panels on the grid pages (#82). Collapsing unmounts the console, which
 * releases the drawer's hold on the stream: with nothing else watching that
 * endpoint the socket closes and the backend can stop the container stream.
 *
 * This drawer goes away at the #86 cutover, when the grid pages replace the
 * fixed dashboard and logs are a panel like everything else.
 */
interface LogViewerProps {
  /** Engine snapshots from the current metrics payload. */
  engines?: EngineSnapshot[]
  /** Endpoint of the engine tab selected in the engine section; null on the
   *  Global tab. */
  selectedEndpoint?: string | null
  onExpandChange?: (expanded: boolean) => void
}

export function LogViewer({
  engines = [],
  selectedEndpoint = null,
  onExpandChange,
}: LogViewerProps) {
  const [collapsed, setCollapsed] = useState(true)

  // Engine whose container is streamed: the selected tab's engine when one is
  // active and still present, otherwise the first Docker engine. The empty
  // string asks the backend for its own default, which applies the same rule.
  const targetEndpoint = useMemo(() => {
    if (selectedEndpoint && findEngineByEndpoint(engines, selectedEndpoint)) {
      return selectedEndpoint
    }
    return engines.find((e) => e.deployment_mode === 'Docker')?.endpoint ?? ''
  }, [engines, selectedEndpoint])

  const targetEngine = findEngineByEndpoint(engines, targetEndpoint)
  const engineLabel = targetEngine ? (targetEngine.model?.name ?? targetEngine.endpoint) : null

  if (collapsed) {
    return (
      <div className="shrink-0 mt-2">
        <button
          onClick={() => {
            setCollapsed(false)
            onExpandChange?.(true)
          }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-zinc-400
                     bg-[#111115] rounded-md border border-white/[0.04] hover:border-zinc-700
                     transition-colors duration-200"
        >
          ▶ Console Logs
          {engineLabel && (
            <span className="text-[10px] text-zinc-600 truncate max-w-[240px]">{engineLabel}</span>
          )}
          <span className="text-zinc-600 ml-auto">click to stream</span>
        </button>
      </div>
    )
  }

  return (
    // Fixed height: the drawer's console is a strip at the foot of a page it
    // does not own, unlike a log panel, which fills the box the operator sized.
    <div className="shrink-0 mt-2 h-60">
      <ExpandedConsole
        endpoint={targetEndpoint}
        label={engineLabel}
        onCollapse={() => {
          setCollapsed(true)
          onExpandChange?.(false)
        }}
      />
    </div>
  )
}

/**
 * The expanded drawer. Split out so the stream is subscribed by mounting: a
 * collapsed drawer holds no connection at all (lazy connect), and expanding is
 * what opens one.
 */
function ExpandedConsole({
  endpoint,
  label,
  onCollapse,
}: {
  endpoint: string
  label: string | null
  onCollapse: () => void
}) {
  const stream = useLogStream(endpoint)

  return (
    <LogConsole
      stream={stream}
      label={label}
      leading={
        <button
          onClick={onCollapse}
          className="text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors shrink-0"
        >
          ▼ Console Logs
        </button>
      }
    />
  )
}
