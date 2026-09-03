import { MetricTile } from '@/components/engines/EnginePanelPrimitives'
import { useLatestSnapshot } from '@/hooks/useMetricsStore'
import { formatAge, formatTps, formatTtft } from '@/lib/format'
import {
  newestFirst,
  requestSummary,
  timelineAxis,
  timelineSpan,
  type TimelineAxis,
} from '@/lib/inferenceTimeline'
import { NVIDIA_THEME } from '@/lib/theme'
import { EnginePanelBody } from './EnginePanelBody'
import { engineIdentity } from './engineLabel'
import { PanelList } from './PanelList'
import { EnginePanelNotice, PanelNotice } from './PanelNotice'
import { useEngineRequests } from './useEnginePanel'
import type { InferenceRequestData } from '@/types/metrics'
import type { PanelContentProps } from '../panelRegistry'

/**
 * The individual requests one engine finished inside the panel's window, each
 * drawn where it happened.
 *
 * Every other engine panel shows an aggregate — tokens per second averaged over
 * a poll, a latency percentile over a histogram. This one is the only place the
 * requests themselves are visible, which is what answers the questions an
 * aggregate cannot: whether the engine is serving one request at a time or
 * twelve at once, and whether the slow p99 is one cold start or a steady tail.
 *
 * The bars are positioned against the panel's window, so the axis is the same
 * one the charts beside it use and two panels can be read together.
 *
 * **No shipped backend fills `recent_requests` yet.** `EngineSnapshot` carries
 * the field and the wire format is settled, but both construction sites in
 * `src/engines/mod.rs` pass an empty vector — per-request metrics wait on the
 * engine adapters. Until one lands, this panel is correct and empty on a real
 * host, which is why the no-requests state is worded as a quiet window rather
 * than as a fault.
 */
export function InferenceTimelinePanel({ panel }: PanelContentProps) {
  const { target, requests } = useEngineRequests(panel)
  const snapshot = useLatestSnapshot()
  if (target.status !== 'resolved') return <EnginePanelNotice resolution={target} />

  // The newest sample anchors the axis, not wall clock: the bars then hold
  // still between snapshots rather than creeping leftward every frame.
  const axis = timelineAxis(snapshot?.timestamp_ms ?? 0, panel.window)
  const { count, medianTps, medianTtftMs } = requestSummary(requests)

  return (
    <EnginePanelBody
      identity={engineIdentity(target)}
      tiles={
        <div className="grid grid-cols-3 gap-1.5">
          <MetricTile label="Requests" value={String(count)} />
          {/* Medians, because one cold start drags a mean far enough to
              misreport the engine — and the bars below already show it. */}
          <MetricTile label="Med tok/s" value={formatTps(medianTps)} />
          <MetricTile label="Med TTFT" value={formatTtft(medianTtftMs)} unit="ms" />
        </div>
      }
      chart={
        count === 0 ? (
          <PanelNotice>No requests finished in the last {panel.window}.</PanelNotice>
        ) : (
          <PanelList label="Inference requests">
            {newestFirst(requests).map((request, i) => (
              <RequestRow
                key={`${request.start_ms}-${request.end_ms}-${i}`}
                request={request}
                axis={axis}
              />
            ))}
          </PanelList>
        )
      }
    />
  )
}

function RequestRow({
  request,
  axis,
}: {
  request: InferenceRequestData
  axis: TimelineAxis
}) {
  const { leftPercent, widthPercent } = timelineSpan(request, axis)
  const seconds = Math.max(0, request.end_ms - request.start_ms) / 1000

  return (
    <li
      className="flex items-center gap-1.5 min-w-0 shrink-0"
      title={`${seconds.toFixed(1)}s · ${formatTps(request.tokens_per_sec)} tok/s · TTFT ${formatTtft(request.ttft_ms)}ms · ${formatAge(request.end_ms, axis.to)} ago`}
    >
      <span className="relative flex-1 min-w-0 h-2 rounded-sm bg-white/[0.04]">
        <span
          className="absolute inset-y-0 rounded-sm"
          style={{
            left: `${leftPercent}%`,
            width: `${widthPercent}%`,
            backgroundColor: NVIDIA_THEME.accent,
          }}
        />
      </span>
      <span className="shrink-0 w-12 text-right font-mono tabular-nums text-[10px] text-zinc-400">
        {formatTps(request.tokens_per_sec)}
      </span>
    </li>
  )
}
