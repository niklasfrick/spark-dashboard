import { useGpuEvents, useLatestSnapshot } from '@/hooks/useMetricsStore'
import { formatAge } from '@/lib/format'
import { gpuIndexOf } from '@/lib/identity'
import { NVIDIA_THEME } from '@/lib/theme'
import { usePanelDevice } from '../panelDevice'
import { GpuPanelNotice } from './PanelNotice'
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
 *
 * Sizes itself by scrolling rather than by dropping content the way the gauge
 * panels do. There is no reduced rendering of an event that is still an event,
 * and the newest are at the top, so a 1×1 cell shows the one that matters.
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
    return (
      <div className="h-full flex items-center justify-center text-center">
        <p className="text-xs text-zinc-500">Nothing reported in the last {panel.window}.</p>
      </div>
    )
  }

  return (
    <ul className="h-full min-h-0 min-w-0 overflow-y-auto flex flex-col gap-0.5 pr-0.5">
      {[...mine].reverse().map((event, i) => (
        <EventRow key={`${event.timestamp_ms}-${event.event_type}-${i}`} event={event} now={now} />
      ))}
    </ul>
  )
}

/**
 * How serious an event is. Thermal slowdowns and Xid errors are the two the
 * operator has to act on — a hardware failure or a cooling problem — where a
 * power cap is the machine working as configured.
 */
function eventColor(eventType: string): string {
  return eventType === 'thermal' || eventType === 'xid'
    ? NVIDIA_THEME.critical
    : NVIDIA_THEME.warning
}

function EventRow({ event, now }: { event: GpuEventData; now: number }) {
  const color = eventColor(event.event_type)

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
