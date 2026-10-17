import {
  METRIC_GROUPS,
  type EngineMetrics,
  type EngineSnapshot,
  type LatencyPercentiles,
  type MetricGroup,
} from '@/types/metrics'
import { contributesGroup, metricGroupOf, type NumericEngineMetric } from './engineMetrics'
import { LATENCY_GROUPS } from './latencyMode'
import { NO_MODEL_LOADED } from './format'
import {
  getNamespacedProviderLogo,
  getProviderLogo,
  modelNamespace,
  providerPrefix,
  type ProviderLogo,
} from './providerLogo'

/**
 * The metric groups whose combined figures are request-weighted means: the
 * latencies measured per request (mean and percentiles of TTFT, end-to-end and
 * per-output-token latency) and queue time. An engine has to report request
 * counts to carry a weight, so one that reports such a group without the
 * RequestTotal group cannot enter its mean.
 */
export const REQUEST_WEIGHTED_GROUPS: ReadonlySet<MetricGroup> = new Set<MetricGroup>([
  ...(['ttft', 'e2e', 'tpot'] as const).flatMap((dimension) => [
    LATENCY_GROUPS[dimension].mean,
    LATENCY_GROUPS[dimension].percentiles,
  ]),
  'QueueTime',
])

/**
 * The metric groups whose combined figures are token-weighted means: the
 * inter-token latency's mean and percentiles (with its goodput), a measure per
 * generated token, weighted by the tokens each engine generated (#151). The
 * engines that report it count those tokens in the Throughput group, so one
 * that counts no requests (llama.cpp) still enters; one that reports such a
 * group without Throughput cannot.
 */
export const TOKEN_WEIGHTED_GROUPS: ReadonlySet<MetricGroup> = new Set<MetricGroup>([
  LATENCY_GROUPS.itl.mean,
  LATENCY_GROUPS.itl.percentiles,
])

/** The group whose counter weights `group`'s combined figures — what they are
 *  measured per — or null for a group whose figures sum or take a plain mean. */
function weightGroupOf(group: MetricGroup): MetricGroup | null {
  if (REQUEST_WEIGHTED_GROUPS.has(group)) return 'RequestTotal'
  if (TOKEN_WEIGHTED_GROUPS.has(group)) return 'Throughput'
  return null
}

/**
 * Whether an engine enters the combined all-models figures of `group`: it is
 * running, its metrics are on, it declares the group — and, for a weighted
 * group, the group its weight is counted in too: RequestTotal for a
 * request-weighted one, Throughput for a token-weighted one. Decided by
 * declaration, never by value, so a host running only vLLM covers exactly the
 * engines it did before engines declared their groups.
 */
export function includedIn(engine: EngineSnapshot, group: MetricGroup): boolean {
  const weightGroup = weightGroupOf(group)
  return (
    contributesGroup(engine, group) &&
    (weightGroup === null || contributesGroup(engine, weightGroup))
  )
}

/** How many engines the combined figures cover, per metric group. */
export interface AggregateCoverage {
  /** Running engines on the host — what "all" means in "2 of 3". */
  running: number
  /** Per group, how many of them a figure of that group combines. */
  included: Readonly<Record<MetricGroup, number>>
}

/** Per group, how many running engines its combined figures cover. */
export function aggregateCoverage(engines: readonly EngineSnapshot[]): AggregateCoverage {
  const running = engines.filter((e) => e.status.type === 'Running')
  const included = Object.fromEntries(
    METRIC_GROUPS.map((group) => [group, running.filter((e) => includedIn(e, group)).length]),
  ) as Record<MetricGroup, number>
  return { running: running.length, included }
}

/** The coverage of one panel's groups — what its note on "2 of 3" reads. */
export interface GroupCoverage {
  running: number
  groups: ReadonlyArray<{ group: MetricGroup; included: number }>
}

/** The coverage of one panel: its groups that at least one engine reports, in the panel's order. */
export function panelCoverage(
  coverage: AggregateCoverage,
  groups: readonly MetricGroup[],
): GroupCoverage {
  return {
    running: coverage.running,
    groups: groups
      .filter((group) => coverage.included[group] > 0)
      .map((group) => ({ group, included: coverage.included[group] })),
  }
}

/**
 * Aggregated metrics across multiple engines for the "Global" dashboard tab.
 *
 * Semantics are per-field: throughput/counts sum (concurrent workers compose
 * additively), latencies are weighted means — by requests, or by generated
 * tokens for the inter-token latency, a per-token measure — and cache
 * percentages are simple means (each engine has its own KV pool, so summing is
 * nonsensical).
 *
 * Each figure combines only the engines included in its metric group
 * (`includedIn`): an engine that does not report a group, or whose metrics are
 * off, is left out rather than entering as a zero. A figure no running engine
 * reports is null.
 */
export interface AggregateSnapshot {
  /** Count of engines whose status is Running. */
  running_count: number
  /** Count of all engines the backend knows about (Running + Loading + Stopped + Error). */
  total_count: number
  /** How many of the running engines each group's figures combine. */
  coverage: AggregateCoverage

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
  total_prompt_tokens: number | null
  total_generation_tokens: number | null
  prefix_cache_queries_total: number | null

  // Speculative decoding. Cumulative counters are summed; TAR and mean
  // acceptance length are recomputed from the summed counters (not averaged
  // per-engine) so they stay correctly volume-weighted across engines, with
  // engines that keep no counters weighted in by their draft rounds.
  spec_decode_draft_tokens_total: number | null
  spec_decode_accepted_tokens_total: number | null
  spec_decode_drafts_total: number | null
  spec_decode_acceptance_rate: number | null
  spec_decode_acceptance_rate_live: number | null
  spec_decode_mean_acceptance_length: number | null

  // Weighted mean by total_requests — inter_token_latency_ms by
  // total_generation_tokens (simple mean fallback)
  ttft_ms: number | null
  e2e_latency_ms: number | null
  queue_time_ms: number | null
  inter_token_latency_ms: number | null
  tpot_ms: number | null
  per_request_tps: number | null
  per_request_prompt_tps: number | null

  // Simple mean across running engines
  avg_batch_size: number | null
  kv_cache_percent: number | null
  prefix_cache_hit_rate: number | null
  /** Whether the KV figure is estimated: true if any pool in its mean is —
   *  a mean over one estimate is one. */
  kv_cache_is_estimated: boolean

  // Tail-latency percentiles, weighted-mean per quantile.
  // NOTE: Cross-engine percentile averaging is approximate — true tail
  // latency would require merging the underlying histograms. We use the
  // same weighted-mean approach as the per-engine averages above for
  // visual consistency on the global card.
  ttft_percentiles: LatencyPercentiles | null
  itl_percentiles: LatencyPercentiles | null
  e2e_percentiles: LatencyPercentiles | null
  tpot_percentiles: LatencyPercentiles | null

  // Goodput (% meeting SLO), weighted like its latency: by total_requests,
  // itl_goodput_pct by total_generation_tokens.
  ttft_goodput_pct: number | null
  itl_goodput_pct: number | null
  e2e_goodput_pct: number | null
  tpot_goodput_pct: number | null
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
    coverage: aggregateCoverage([]),
    tokens_per_sec: null,
    avg_tokens_per_sec: null,
    prompt_tokens_per_sec: null,
    avg_prompt_tokens_per_sec: null,
    active_requests: null,
    queued_requests: null,
    total_requests: null,
    swapped_requests: null,
    preemptions_total: null,
    total_prompt_tokens: null,
    total_generation_tokens: null,
    prefix_cache_queries_total: null,
    spec_decode_draft_tokens_total: null,
    spec_decode_accepted_tokens_total: null,
    spec_decode_drafts_total: null,
    spec_decode_acceptance_rate: null,
    spec_decode_acceptance_rate_live: null,
    spec_decode_mean_acceptance_length: null,
    ttft_ms: null,
    e2e_latency_ms: null,
    queue_time_ms: null,
    inter_token_latency_ms: null,
    tpot_ms: null,
    per_request_tps: null,
    per_request_prompt_tps: null,
    avg_batch_size: null,
    kv_cache_percent: null,
    prefix_cache_hit_rate: null,
    kv_cache_is_estimated: false,
    ttft_percentiles: null,
    itl_percentiles: null,
    e2e_percentiles: null,
    tpot_percentiles: null,
    ttft_goodput_pct: null,
    itl_goodput_pct: null,
    e2e_goodput_pct: null,
    tpot_goodput_pct: null,
  }
}

/**
 * Aggregates a single percentile field across running engines using a
 * weighted mean (weighted like the latency's mean). Returns null
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
 *
 * An engine holding a list of models (Ollama) counts once too, on the
 * engine-level logo rule: one model is filed under the provider its name
 * spells out — never one guessed from a keyword — while an idle engine reads
 * as having no model loaded and one holding several as several models, since
 * no one provider is theirs.
 */
export function groupRunningByProvider(
  engines: readonly EngineSnapshot[],
): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>()
  for (const e of engines) {
    if (e.status.type !== 'Running') continue
    const { key, label, logo } = providerOf(e)

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

const UNKNOWN_PROVIDER = { key: 'unknown', label: 'Unknown', logo: null }

/** The provider group one running engine is filed under. */
function providerOf(engine: EngineSnapshot): Omit<ProviderGroup, 'count'> {
  const loaded = engine.loaded_models
  if (loaded != null) {
    if (loaded.length === 0) return { key: 'no-model', label: NO_MODEL_LOADED, logo: null }
    if (loaded.length > 1) return { key: 'several-models', label: 'Multi-model', logo: null }
    const [only] = loaded
    return byProvider(getNamespacedProviderLogo(only.name), modelNamespace(only.name))
  }

  const name = engine.model?.name ?? null
  return byProvider(getProviderLogo(name), providerPrefix(name))
}

/** A resolved provider by its mark; otherwise the organization as written, or
 *  'Unknown' when the name carries none. */
function byProvider(logo: ProviderLogo | null, rawOrg: string | null): Omit<ProviderGroup, 'count'> {
  if (logo) return { key: logo.slug, label: logo.alt, logo }
  if (rawOrg) return { key: `raw:${rawOrg.toLowerCase()}`, label: rawOrg, logo: null }
  return UNKNOWN_PROVIDER
}

export function aggregateEngines(engines: readonly EngineSnapshot[]): AggregateSnapshot {
  const running = engines.filter((e) => e.status.type === 'Running')
  if (running.length === 0) {
    return emptySnapshot(engines.length)
  }

  // One value per running engine, masked to null for an engine not included in
  // the field's group — so every combination below skips it exactly as it
  // skips an engine without a sample, and never reads its value as a zero.
  const get = <K extends keyof EngineMetrics>(key: K): Array<EngineMetrics[K] | null> =>
    running.map((e) => (includedIn(e, metricGroupOf(key)) ? (e.metrics?.[key] ?? null) : null))

  // A latency is weighted by what it is measured per: the inter-token latency
  // by the tokens each engine generated, every other by its requests. A weight
  // is null for an engine that does not report its counter, so it carries
  // none; that engine's latencies are masked above too, so the simple-mean
  // fallback below only ever runs over engines that do report the counter.
  const requests = get('total_requests')
  const tokens = get('total_generation_tokens')
  const weightsByGroup: Partial<Record<MetricGroup, typeof requests>> = {
    RequestTotal: requests,
    Throughput: tokens,
  }
  // The split lives in weightGroupOf; a group it leaves unweighted falls back
  // to the requests, as every latency did before the inter-token one moved.
  const weightsOf = (key: keyof EngineMetrics) =>
    weightsByGroup[weightGroupOf(metricGroupOf(key)) ?? 'RequestTotal'] ?? requests
  const weightedBy = (key: NumericEngineMetric) => {
    const weights = weightsOf(key)
    return weightedMeanOrNull(get(key).map((value, i) => ({ value, weight: weights[i] })))
  }

  // Speculative decoding. The engines that count drafted and accepted tokens
  // (vLLM) pool their counters, and TAR and mean acceptance length are
  // recomputed from the pooled sums so they are volume-weighted across engines
  // rather than naively averaged. An engine that reports only its acceptance
  // figures — SGLang, which keeps no token counters — enters with those
  // figures, weighted by its draft rounds against the pool's draft rounds, so
  // each engine counts for as many rounds as it ran. A host running only vLLM
  // combines exactly as before. ratio() guards divide-by-zero.
  const specDraftTokens = sumOrNull(get('spec_decode_draft_tokens_total'))
  const specAcceptedTokens = sumOrNull(get('spec_decode_accepted_tokens_total'))
  const specDrafts = sumOrNull(get('spec_decode_drafts_total'))
  const ratio = (num: number | null, den: number | null, scale = 1): number | null =>
    num !== null && den !== null && den > 0 ? (num / den) * scale : null
  const acceptedTokens = get('spec_decode_accepted_tokens_total')
  const draftRounds = get('spec_decode_drafts_total')
  const pooledRounds = sumOrNull(draftRounds.filter((_, i) => acceptedTokens[i] !== null))
  const withFigureOnlyEngines = (
    pooled: number | null,
    key: 'spec_decode_acceptance_rate' | 'spec_decode_mean_acceptance_length',
  ) =>
    weightedMeanOrNull([
      { value: pooled, weight: pooledRounds },
      ...get(key).map((value, i) => ({
        value: acceptedTokens[i] === null ? value : null,
        weight: draftRounds[i],
      })),
    ])

  return {
    running_count: running.length,
    total_count: engines.length,
    coverage: aggregateCoverage(engines),

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
    total_prompt_tokens: sumOrNull(get('total_prompt_tokens')),
    total_generation_tokens: sumOrNull(get('total_generation_tokens')),
    prefix_cache_queries_total: sumOrNull(get('prefix_cache_queries_total')),

    // Speculative decoding — additive counters + sum-derived ratios.
    spec_decode_draft_tokens_total: specDraftTokens,
    spec_decode_accepted_tokens_total: specAcceptedTokens,
    spec_decode_drafts_total: specDrafts,
    spec_decode_acceptance_rate: withFigureOnlyEngines(
      ratio(specAcceptedTokens, specDraftTokens, 100),
      'spec_decode_acceptance_rate',
    ),
    // Live TAR is a per-poll rolling value with no underlying delta exposed
    // here to re-sum, so we weight each engine's live TAR by its lifetime
    // draft-token volume. This is an approximation: vLLM exposes no windowed
    // draft count, so a long-running high-traffic engine biases the blend even
    // if its current draft rate matches a newer engine. Engines without
    // spec-decode contribute {value: null, weight: null} and are dropped by
    // weightedMeanOrNull, so a mixed fleet blends only the spec-decode engines.
    spec_decode_acceptance_rate_live: weightedMeanOrNull(
      get('spec_decode_acceptance_rate_live').map((value, i) => ({
        value,
        weight: get('spec_decode_draft_tokens_total')[i],
      })),
    ),
    spec_decode_mean_acceptance_length: withFigureOnlyEngines(
      ratio(specAcceptedTokens, pooledRounds),
      'spec_decode_mean_acceptance_length',
    ),

    // Weighted mean — by requests, the inter-token latency by generated tokens
    ttft_ms: weightedBy('ttft_ms'),
    e2e_latency_ms: weightedBy('e2e_latency_ms'),
    queue_time_ms: weightedBy('queue_time_ms'),
    inter_token_latency_ms: weightedBy('inter_token_latency_ms'),
    tpot_ms: weightedBy('tpot_ms'),
    per_request_tps: weightedBy('per_request_tps'),
    per_request_prompt_tps: weightedBy('per_request_prompt_tps'),

    // Simple mean
    avg_batch_size: meanOrNull(get('avg_batch_size')),
    kv_cache_percent: meanOrNull(get('kv_cache_percent')),
    prefix_cache_hit_rate: meanOrNull(get('prefix_cache_hit_rate')),
    kv_cache_is_estimated: get('kv_cache_is_estimated').some((estimated) => estimated === true),

    // Tail latency — weighted mean per quantile, weighted like its mean.
    ttft_percentiles: aggregatePercentiles(get('ttft_percentiles'), weightsOf('ttft_percentiles')),
    itl_percentiles: aggregatePercentiles(get('itl_percentiles'), weightsOf('itl_percentiles')),
    e2e_percentiles: aggregatePercentiles(get('e2e_percentiles'), weightsOf('e2e_percentiles')),
    tpot_percentiles: aggregatePercentiles(get('tpot_percentiles'), weightsOf('tpot_percentiles')),

    // Goodput — weighted mean like its latency, same caveat as percentiles.
    ttft_goodput_pct: weightedBy('ttft_goodput_pct'),
    itl_goodput_pct: weightedBy('itl_goodput_pct'),
    e2e_goodput_pct: weightedBy('e2e_goodput_pct'),
    tpot_goodput_pct: weightedBy('tpot_goodput_pct'),
  }
}

/**
 * The aggregate reshaped as one engine's metrics, so a following engine panel
 * on a page configured for all models renders the combined figures through the
 * same reader and series it uses for a single engine. Null when no engine is
 * running — an aggregate over nothing is not a row of zeros.
 *
 * The histogram buckets are deliberately null: engines can carry different
 * bucket layouts, and merging mismatched histograms would manufacture a
 * distribution nobody measured. The SLO panel already falls back to the
 * backend-computed goodput percentages, which aggregate as weighted means.
 */
export function asEngineMetrics(aggregate: AggregateSnapshot): EngineMetrics | null {
  if (aggregate.running_count === 0) return null

  return {
    tokens_per_sec: aggregate.tokens_per_sec,
    avg_tokens_per_sec: aggregate.avg_tokens_per_sec,
    per_request_tps: aggregate.per_request_tps,
    ttft_ms: aggregate.ttft_ms,
    active_requests: aggregate.active_requests,
    queued_requests: aggregate.queued_requests,
    kv_cache_percent: aggregate.kv_cache_percent,
    kv_cache_is_estimated: aggregate.kv_cache_is_estimated,
    total_requests: aggregate.total_requests,
    e2e_latency_ms: aggregate.e2e_latency_ms,
    prompt_tokens_per_sec: aggregate.prompt_tokens_per_sec,
    avg_prompt_tokens_per_sec: aggregate.avg_prompt_tokens_per_sec,
    per_request_prompt_tps: aggregate.per_request_prompt_tps,
    swapped_requests: aggregate.swapped_requests,
    prefix_cache_hit_rate: aggregate.prefix_cache_hit_rate,
    queue_time_ms: aggregate.queue_time_ms,
    inter_token_latency_ms: aggregate.inter_token_latency_ms,
    preemptions_total: aggregate.preemptions_total,
    total_prompt_tokens: aggregate.total_prompt_tokens,
    total_generation_tokens: aggregate.total_generation_tokens,
    prefix_cache_queries_total: aggregate.prefix_cache_queries_total,
    avg_batch_size: aggregate.avg_batch_size,
    ttft_percentiles: aggregate.ttft_percentiles,
    itl_percentiles: aggregate.itl_percentiles,
    e2e_percentiles: aggregate.e2e_percentiles,
    ttft_goodput_pct: aggregate.ttft_goodput_pct,
    itl_goodput_pct: aggregate.itl_goodput_pct,
    e2e_goodput_pct: aggregate.e2e_goodput_pct,
    ttft_buckets: null,
    itl_buckets: null,
    e2e_buckets: null,
    tpot_ms: aggregate.tpot_ms,
    tpot_percentiles: aggregate.tpot_percentiles,
    tpot_goodput_pct: aggregate.tpot_goodput_pct,
    tpot_buckets: null,
    spec_decode_draft_tokens_total: aggregate.spec_decode_draft_tokens_total,
    spec_decode_accepted_tokens_total: aggregate.spec_decode_accepted_tokens_total,
    spec_decode_drafts_total: aggregate.spec_decode_drafts_total,
    spec_decode_acceptance_rate: aggregate.spec_decode_acceptance_rate,
    spec_decode_acceptance_rate_live: aggregate.spec_decode_acceptance_rate_live,
    spec_decode_mean_acceptance_length: aggregate.spec_decode_mean_acceptance_length,
  }
}

/**
 * The all-models figures as one engine's metrics — `asEngineMetrics` over
 * `aggregateEngines`. The history store ingests this, so the all-models series
 * follow the same inclusion rule as the tiles.
 */
export function aggregateEngineMetrics(engines: readonly EngineSnapshot[]): EngineMetrics | null {
  return asEngineMetrics(aggregateEngines(engines))
}
