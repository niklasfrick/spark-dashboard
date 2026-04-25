import type { EngineSnapshot, LatencyPercentiles } from '@/types/metrics'
import { getProviderLogo, type ProviderLogo } from './providerLogo'

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
  inter_token_latency_ms: number | null
  per_request_tps: number | null
  per_request_prompt_tps: number | null

  // Simple mean across running engines
  avg_batch_size: number | null
  kv_cache_percent: number | null
  prefix_cache_hit_rate: number | null

  // Tail-latency percentiles, weighted-mean per quantile.
  // NOTE: Cross-engine percentile averaging is approximate — true tail
  // latency would require merging the underlying histograms. We use the
  // same weighted-mean approach as the per-engine averages above for
  // visual consistency on the global card.
  ttft_percentiles: LatencyPercentiles | null
  itl_percentiles: LatencyPercentiles | null
  e2e_percentiles: LatencyPercentiles | null
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
    inter_token_latency_ms: null,
    per_request_tps: null,
    per_request_prompt_tps: null,
    avg_batch_size: null,
    kv_cache_percent: null,
    prefix_cache_hit_rate: null,
    ttft_percentiles: null,
    itl_percentiles: null,
    e2e_percentiles: null,
  }
}

/**
 * Aggregates a single percentile field across running engines using a
 * weighted mean (same weighting as the latency averages). Returns null
 * when no engine reports the field. Each quantile is independently
 * aggregated; if every engine has the percentiles object but a given
 * quantile is null, that quantile stays null.
 */
function aggregatePercentiles(
  perEngine: Array<LatencyPercentiles | null | undefined>,
  weights: Array<number | null | undefined>,
): LatencyPercentiles | null {
  const present = perEngine.some((p) => p !== null && p !== undefined)
  if (!present) return null
  const quantile = (key: keyof LatencyPercentiles) =>
    weightedMeanOrNull(
      perEngine.map((p, i) => ({
        value: p ? (p[key] as number | null) : null,
        weight: weights[i],
      })),
    )
  return {
    p50_ms: quantile('p50_ms'),
    p95_ms: quantile('p95_ms'),
    p99_ms: quantile('p99_ms'),
  }
}

/**
 * One entry per distinct provider among the running engines — used by the
 * "All Engines" header to show per-provider pill chips in place of a subtitle.
 */
export interface ProviderGroup {
  /** Null when the served model has no recognizable provider. */
  logo: ProviderLogo | null
  /** Display label: resolved provider name, raw `Org/` prefix, or 'Unknown'. */
  label: string
  /** Stable React key — slug for resolved providers, fallback key otherwise. */
  key: string
  /** Count of running engines whose served model maps to this provider. */
  count: number
}

/**
 * Groups running engines by the provider of their served model. Providers
 * with no resolvable logo fall back to the raw `Org/` prefix or 'unknown'
 * so every running engine is still accounted for.
 */
export function groupRunningByProvider(
  engines: readonly EngineSnapshot[],
): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>()
  for (const e of engines) {
    if (e.status.type !== 'Running') continue
    const name = e.model?.name ?? null
    const logo = getProviderLogo(name)

    let key: string
    let label: string
    if (logo) {
      key = logo.slug
      label = logo.alt
    } else if (name) {
      const slashIdx = name.indexOf('/')
      const rawPrefix = slashIdx > 0 ? name.slice(0, slashIdx).trim() : ''
      if (rawPrefix) {
        key = `raw:${rawPrefix.toLowerCase()}`
        label = rawPrefix
      } else {
        key = 'unknown'
        label = 'Unknown'
      }
    } else {
      key = 'unknown'
      label = 'Unknown'
    }

    const existing = groups.get(key)
    if (existing) {
      existing.count += 1
    } else {
      groups.set(key, { logo, label, key, count: 1 })
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return a.label.localeCompare(b.label)
  })
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
    inter_token_latency_ms: weightedBy('inter_token_latency_ms'),
    per_request_tps: weightedBy('per_request_tps'),
    per_request_prompt_tps: weightedBy('per_request_prompt_tps'),

    // Simple mean
    avg_batch_size: meanOrNull(get('avg_batch_size')),
    kv_cache_percent: meanOrNull(get('kv_cache_percent')),
    prefix_cache_hit_rate: meanOrNull(get('prefix_cache_hit_rate')),

    // Tail latency — weighted mean per quantile.
    ttft_percentiles: aggregatePercentiles(
      metrics.map((m) => m?.ttft_percentiles ?? null),
      weights,
    ),
    itl_percentiles: aggregatePercentiles(
      metrics.map((m) => m?.itl_percentiles ?? null),
      weights,
    ),
    e2e_percentiles: aggregatePercentiles(
      metrics.map((m) => m?.e2e_percentiles ?? null),
      weights,
    ),
  }
}
