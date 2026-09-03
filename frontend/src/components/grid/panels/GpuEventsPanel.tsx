import { useGpuEvents, useLatestSnapshot } from '@/hooks/useMetricsStore'
import { formatAge } from '@/lib/format'
import { gpuIndexOf } from '@/lib/identity'
import { gpuEventColor } from '@/lib/theme'
import { usePanelDevice } from '../panelDevice'
import { PanelList } from './PanelList'
import { GpuPanelNotice, PanelNotice } from './PanelNotice'
import { useGpuPanel } from './useGpuPanel'
import type { GpuEventData } from '@/types/metrics'
import type { PanelContentProps } from '../panelRegistry'

/**
 * What one GPU has complained about inside the panel's window: thermal
 * slowdowns, hardware throttling, power brakes.
 *
 * A list rather than a chart, because an event has no value to plot — it either
 * happened or it did not, and the thing an operator needs is which one and how
 * long ago. It reads beside the temperature and power panels: those say the GPU
 * is at 88°C, this says the driver has started clipping its clocks over it.
 */
export function GpuEventsPanel({ panel }: PanelContentProps) {
  const resolution = useGpuPanel(panel)
  const events = useGpuEvents(panel.window)
  const snapshot = useLatestSnapshot()
  // Above the early return, like every hook here — a panel whose binding has
  // not resolved still has to call it, with nothing to report.
  usePanelDevice(resolution.status === 'resolved' ? resolution.gpu.name : null)

  if (resolution.status !== 'resolved') return <GpuPanelNotice resolution={resolution} />

  const index = gpuIndexOf(resolution.gpu)
  // `gpu_index` is nullable on the wire, and null means the primary GPU — the
  // same normalization `gpuIndexOf` applies to the GPU itself, so an event the
  // collector could not attribute lands on the panel showing GPU 0 rather than
  // on none of them.
  const mine = events.filter((event) => (event.gpu_index ?? 0) === index)
  // The newest sample, not wall clock: the ages then hold still between
  // snapshots instead of ticking under a dashboard nobody is touching.
  const now = snapshot?.timestamp_ms ?? 0

  if (mine.length === 0) {
    return <PanelNotice>Nothing reported in the last {panel.window}.</PanelNotice>
  }

  // Sorted rather than reversed: a poll that detected three throttle reasons at
  // once stamps them all with the same time, and a stable sort leaves those in
  // the order the collector found them instead of inverting it.
  const newestFirst = [...mine].sort((a, b) => b.timestamp_ms - a.timestamp_ms)

  return (
    <PanelList label="GPU events">
      {newestFirst.map((event, i) => (
        <EventRow key={`${event.timestamp_ms}-${event.event_type}-${i}`} event={event} now={now} />
      ))}
    </PanelList>
  )
}

function EventRow({ event, now }: { event: GpuEventData; now: number }) {
  const color = gpuEventColor(event.event_type)

  return (
    <li className="flex items-baseline gap-1.5 min-w-0 leading-tight">
      <span
        className="shrink-0 rounded px-1 text-[9px] font-medium uppercase tracking-wider"
        style={{ color, backgroundColor: `${color}1a` }}
      >
        {event.event_type.replace(/_/g, ' ')}
      </span>
      <span className="flex-1 min-w-0 truncate text-[11px] text-zinc-300" title={event.detail}>
        {event.detail}
      </span>
      <span className="shrink-0 font-mono tabular-nums text-[10px] text-zinc-500">
        {formatAge(event.timestamp_ms, now)} ago
      </span>
    </li>
  )
}
