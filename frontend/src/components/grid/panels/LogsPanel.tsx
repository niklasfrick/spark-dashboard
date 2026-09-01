import { LogConsole } from '@/components/LogConsole'
import { useLogStream } from '@/hooks/useLogStream'
import { engineLabel } from './engineLabel'
import { EnginePanelNotice } from './PanelNotice'
import { useEngineTarget, type ResolvedEngineTarget } from './useEnginePanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * One engine's container logs, placeable and sizable like any other panel.
 *
 * The console used to be permanent chrome at the foot of the dashboard. It is a
 * panel here because the two ends of the audience want opposite things: someone
 * debugging a model that will not load wants a log panel filling a page of its
 * own, and someone running a wall display wants none. A permanent exception
 * would only have bred more of them.
 *
 * The connection is shared per engine endpoint (`LogStreamStore`), so several
 * log panels on one engine cost the backend one docker-logs stream between them.
 */
export function LogsPanel({ panel }: PanelContentProps) {
  // Deliberately the raw binding target rather than `useEnginePanel`: an engine
  // that is starting or not serving has no metrics, and that is precisely when
  // an operator opens its logs. Gating the panel on availability would hide the
  // output that explains why the engine is in that state.
  const target = useEngineTarget(panel)
  if (target.status !== 'resolved') return <EnginePanelNotice resolution={target} />

  // The stream is subscribed one component down, so switching engines remounts
  // nothing and a panel bound to no engine holds no connection at all.
  return <EngineLogs target={target} />
}

function EngineLogs({ target }: { target: ResolvedEngineTarget }) {
  const stream = useLogStream(target.engine.endpoint)
  return <LogConsole stream={stream} label={engineLabel(target)} />
}
