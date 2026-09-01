// GpuEvent is the component-facing type (from events.ts)
// GpuEventData is the wire-format type (from metrics.ts)
// They are structurally compatible; getEvents() in useMetricsHistory returns GpuEventData[]
// which can be mapped to GpuEvent[] when passed to components
export interface GpuEvent {
  timestamp_ms: number
  gpu_index?: number | null
  event_type: 'thermal' | 'throttle' | 'power_brake' | 'xid'
  detail: string
}

// InferenceRequest is the component-facing type (from events.ts)
// InferenceRequestData is the wire-format type (from metrics.ts)
// getRequests() returns InferenceRequestData[] which maps to InferenceRequest[]
export interface InferenceRequest {
  start_ms: number
  end_ms: number
  tps: number
  ttft_ms: number
}

export type TimeWindow = '5m' | '10m' | '15m'

export const TIME_WINDOW_SECONDS: Record<TimeWindow, number> = {
  '5m': 300,
  '10m': 600,
  '15m': 900,
}

/**
 * Every window a panel can cover, shortest first — the order they are offered
 * in. Written out rather than derived from the table above, because the order
 * is part of what this is and object key order is not something to lean on; a
 * spec holds the two in step.
 */
export const TIME_WINDOWS: readonly TimeWindow[] = ['5m', '10m', '15m']
