/**
 * Reading one engine's metrics, and deciding whether there are any to read.
 *
 * Both rules are shared rather than re-derived per card or panel, because both
 * are easy to get subtly wrong in ways that show stale numbers: an engine whose
 * model was unloaded still ships its last metrics, and an engine that has just
 * started ships none at all while being perfectly healthy.
 */

import {
  METRIC_GROUPS,
  type EngineMetrics,
  type EngineSnapshot,
  type MetricGroup,
} from '@/types/metrics'

/** The parts of an engine snapshot that decide what its metrics mean. */
export type EngineReadable = Pick<EngineSnapshot, 'status' | 'model' | 'metrics'>

/**
 * The metric fields that carry a plain number — everything a tile can render
 * directly, as opposed to the percentile structs and histogram buckets that a
 * panel has to derive something from first.
 */
export type NumericEngineMetric = {
  [K in keyof EngineMetrics]-?: EngineMetrics[K] extends number | null ? K : never
}[keyof EngineMetrics]

/** Reads one field of an engine's metrics; null when there is no value to read. */
export type EngineMetricReader = <K extends keyof EngineMetrics>(
  key: K,
) => EngineMetrics[K] | null

/**
 * A reader over one engine's metrics.
 *
 * An engine with **no model loaded** reads as having no values at all. Its last
 * metrics describe a model that is no longer being served, and showing them
 * would put numbers from a finished run under the name of an idle engine.
 */
export function engineMetricReader(engine: EngineReadable): EngineMetricReader {
  const metrics = engine.model === null ? null : engine.metrics
  return (key) => metrics?.[key] ?? null
}

/**
 * The metric groups an engine reports — read off the snapshot, where its
 * backend adapter declared them, and never inferred from its engine type
 * (ADR-0004): what an engine exposes depends on its version and its launch
 * flags, which only the backend sees.
 *
 * A snapshot without the field comes from a backend older than it, and that
 * backend reported every group; reading the absence as "none" would turn every
 * panel on an upgraded frontend into a placeholder. An empty list is different:
 * that engine reports nothing.
 */
export function reportedMetricGroups(
  engine: Pick<EngineSnapshot, 'metric_groups'>,
): ReadonlySet<MetricGroup> {
  return new Set(engine.metric_groups ?? METRIC_GROUPS)
}

/**
 * The metric group each engine metric belongs to — the grain at which an engine
 * reports a field or does not, and the grain of a tile. Exhaustive by type: a
 * field added to `EngineMetrics` does not compile until it is filed here.
 *
 * A per-request rate is filed with the latency mean of its phase (prompt rate
 * with TTFT, generation rate with TPOT), because an engine reports it exactly
 * when it reports that mean. The percentiles, goodput and histogram buckets of
 * one dimension all derive from the same histogram, so they share one group.
 * The backend mirrors this table in `EngineMetrics::reported_only`.
 */
export const METRIC_FIELD_GROUP = {
  tokens_per_sec: 'Throughput',
  avg_tokens_per_sec: 'Throughput',
  prompt_tokens_per_sec: 'Throughput',
  avg_prompt_tokens_per_sec: 'Throughput',
  total_prompt_tokens: 'Throughput',
  total_generation_tokens: 'Throughput',

  avg_batch_size: 'BatchSize',

  active_requests: 'ActiveRequests',
  queued_requests: 'ActiveRequests',

  total_requests: 'RequestTotal',

  swapped_requests: 'Preemptions',
  preemptions_total: 'Preemptions',

  queue_time_ms: 'QueueTime',

  kv_cache_percent: 'KvCache',
  kv_cache_is_estimated: 'KvCache',

  prefix_cache_hit_rate: 'PrefixCache',
  prefix_cache_queries_total: 'PrefixCache',

  spec_decode_draft_tokens_total: 'SpeculativeDecoding',
  spec_decode_accepted_tokens_total: 'SpeculativeDecoding',
  spec_decode_drafts_total: 'SpeculativeDecoding',
  spec_decode_acceptance_rate: 'SpeculativeDecoding',
  spec_decode_acceptance_rate_live: 'SpeculativeDecoding',
  spec_decode_mean_acceptance_length: 'SpeculativeDecoding',

  ttft_ms: 'TtftMean',
  per_request_prompt_tps: 'TtftMean',
  ttft_percentiles: 'TtftPercentiles',
  ttft_buckets: 'TtftPercentiles',
  ttft_goodput_pct: 'TtftPercentiles',

  e2e_latency_ms: 'E2eMean',
  e2e_percentiles: 'E2ePercentiles',
  e2e_buckets: 'E2ePercentiles',
  e2e_goodput_pct: 'E2ePercentiles',

  inter_token_latency_ms: 'ItlMean',
  itl_percentiles: 'ItlPercentiles',
  itl_buckets: 'ItlPercentiles',
  itl_goodput_pct: 'ItlPercentiles',

  tpot_ms: 'TpotMean',
  per_request_tps: 'TpotMean',
  tpot_percentiles: 'TpotPercentiles',
  tpot_buckets: 'TpotPercentiles',
  tpot_goodput_pct: 'TpotPercentiles',
} as const satisfies Record<keyof EngineMetrics, MetricGroup>

/** The metric group an engine metric belongs to. */
export function metricGroupOf(key: keyof EngineMetrics): MetricGroup {
  return METRIC_FIELD_GROUP[key]
}

/**
 * Whether an engine reports any metrics at all: false for one that declares no
 * group, and for one whose metrics endpoint is off — which says nothing about
 * what it would declare once turned on. A backend older than the declaration
 * reported every group, so its engines report metrics.
 */
export function reportsMetrics(
  engine: Pick<EngineSnapshot, 'metric_groups' | 'metrics_off'>,
): boolean {
  if (engine.metrics_off) return false
  return reportedMetricGroups(engine).size > 0
}

/**
 * Whether an engine enters a combined all-models figure of `group`: it has to be
 * running, have its metrics on, and declare the group. Decided by declaration,
 * never by value — an engine that reports a group but has no sample yet still
 * counts, as it does in "N of M serving", and adds nothing until one arrives.
 */
export function contributesGroup(
  engine: Pick<EngineSnapshot, 'status' | 'metric_groups' | 'metrics_off'>,
  group: MetricGroup,
): boolean {
  return (
    engine.status.type === 'Running' &&
    !engine.metrics_off &&
    reportedMetricGroups(engine).has(group)
  )
}

/** Whether an engine has metrics worth rendering, and why not when it has not. */
export type EngineAvailability =
  /** Serving, with metrics. */
  | { kind: 'ready' }
  /** Up, but no metrics have arrived yet — starting, or loading a model. */
  | { kind: 'starting' }
  /** Nothing to show, for a reason the operator can act on. `detail` completes
   *  the sentence "<engine> …". */
  | { kind: 'offline'; detail: string }

/**
 * What an engine can currently show.
 *
 * The distinction that matters is between an engine that is *fine and not ready
 * yet* and one that is *not running*: the first resolves itself in a second, the
 * second needs the operator to do something. A grid of dashes says neither.
 */
export function engineAvailability(engine: EngineReadable): EngineAvailability {
  switch (engine.status.type) {
    case 'Stopped':
      return { kind: 'offline', detail: 'is not running.' }
    case 'Error':
      return { kind: 'offline', detail: `reported an error: ${engine.status.message}` }
  }

  if (engine.model === null) return { kind: 'offline', detail: 'has no model loaded.' }
  return engine.metrics === null ? { kind: 'starting' } : { kind: 'ready' }
}
