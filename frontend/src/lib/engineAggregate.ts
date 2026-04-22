import type { EngineSnapshot } from '@/types/metrics'

/**
 * Aggregated metrics across multiple engines for the "Global" dashboard tab.
 *
 * Semantics are per-field: throughput/counts sum (concurrent workers compose
 * additively), latencies are request-weighted means, and cache percentages
 * are simple means (each engine has its own KV pool, so summing is nonsensical).
 */
export interface AggregateSnapshot {
  /** Count of engines whose status is Running. */
  running_count: number
  /** Count of all engines the backend knows about (Running + Loading + Stopped + Error). */
  total_count: number

  // SUM across running engines
  tokens_per_sec: number | null
  avg_tokens_per_sec: number | null
  prompt_tokens_per_sec: number | null
  avg_prompt_tokens_per_sec: number | null
  active_requests: number | null
  queued_requests: number | null
  total_requests: number | null
  swapped_requests: number | null
  preemptions_total: number | null

  // Weighted mean by total_requests (simple mean fallback)
  ttft_ms: number | null
  e2e_latency_ms: number | null
  queue_time_ms: number | null
  per_request_tps: number | null
  per_request_prompt_tps: number | null

  // Simple mean across running engines
  avg_batch_size: number | null
  kv_cache_percent: number | null
  prefix_cache_hit_rate: number | null
}

function sumOrNull(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v !== null && v !== undefined)
  if (present.length === 0) return null
  return present.reduce((acc, v) => acc + v, 0)
}

function meanOrNull(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v !== null && v !== undefined)
  if (present.length === 0) return null
  return present.reduce((acc, v) => acc + v, 0) / present.length
}

interface Weighted {
  value: number | null | undefined
  weight: number | null | undefined
}

/**
 * Weighted mean of `value` by `weight`. Falls back to a simple mean of the
 * values when every weight is null/zero, since "equal weight across engines"
 * is a saner default than "return null" when data is present.
 */
function weightedMeanOrNull(items: Weighted[]): number | null {
  const withValues = items.filter(
    (i): i is { value: number; weight: number | null | undefined } =>
      i.value !== null && i.value !== undefined,
  )
  if (withValues.length === 0) return null

  let totalWeight = 0
  let weightedSum = 0
  for (const { value, weight } of withValues) {
    if (weight !== null && weight !== undefined && weight > 0) {
      totalWeight += weight
      weightedSum += value * weight
    }
  }

  if (totalWeight > 0) {
    return weightedSum / totalWeight
  }

  // Fallback: simple mean over the values that are present.
  return withValues.reduce((acc, { value }) => acc + value, 0) / withValues.length
}

function emptySnapshot(totalCount: number): AggregateSnapshot {
  return {
    running_count: 0,
    total_count: totalCount,
    tokens_per_sec: null,
    avg_tokens_per_sec: null,
    prompt_tokens_per_sec: null,
    avg_prompt_tokens_per_sec: null,
    active_requests: null,
    queued_requests: null,
    total_requests: null,
    swapped_requests: null,
    preemptions_total: null,
    ttft_ms: null,
    e2e_latency_ms: null,
    queue_time_ms: null,
    per_request_tps: null,
    per_request_prompt_tps: null,
    avg_batch_size: null,
    kv_cache_percent: null,
    prefix_cache_hit_rate: null,
  }
}

export function aggregateEngines(engines: readonly EngineSnapshot[]): AggregateSnapshot {
  const running = engines.filter((e) => e.status.type === 'Running')
  if (running.length === 0) {
    return emptySnapshot(engines.length)
  }

  const metrics = running.map((e) => e.metrics)
  const get = (key: keyof NonNullable<EngineSnapshot['metrics']>) =>
    metrics.map((m) => (m ? (m[key] as number | null | undefined) : null))

  const weights = get('total_requests')
  const weightedBy = (key: keyof NonNullable<EngineSnapshot['metrics']>) =>
    weightedMeanOrNull(
      get(key).map((value, i) => ({ value, weight: weights[i] })),
    )

  return {
    running_count: running.length,
    total_count: engines.length,

    // Additive
    tokens_per_sec: sumOrNull(get('tokens_per_sec')),
    avg_tokens_per_sec: sumOrNull(get('avg_tokens_per_sec')),
    prompt_tokens_per_sec: sumOrNull(get('prompt_tokens_per_sec')),
    avg_prompt_tokens_per_sec: sumOrNull(get('avg_prompt_tokens_per_sec')),
    active_requests: sumOrNull(get('active_requests')),
    queued_requests: sumOrNull(get('queued_requests')),
    total_requests: sumOrNull(get('total_requests')),
    swapped_requests: sumOrNull(get('swapped_requests')),
    preemptions_total: sumOrNull(get('preemptions_total')),

    // Weighted mean
    ttft_ms: weightedBy('ttft_ms'),
    e2e_latency_ms: weightedBy('e2e_latency_ms'),
    queue_time_ms: weightedBy('queue_time_ms'),
    per_request_tps: weightedBy('per_request_tps'),
    per_request_prompt_tps: weightedBy('per_request_prompt_tps'),

    // Simple mean
    avg_batch_size: meanOrNull(get('avg_batch_size')),
    kv_cache_percent: meanOrNull(get('kv_cache_percent')),
    prefix_cache_hit_rate: meanOrNull(get('prefix_cache_hit_rate')),
  }
}
