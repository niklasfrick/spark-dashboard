import { describe, it, expect } from 'vitest'
import {
  aggregateCoverage,
  aggregateEngineMetrics,
  aggregateEngines,
  groupRunningByProvider,
  includedIn,
  panelCoverage,
} from './engineAggregate'
import {
  METRIC_GROUPS,
  type EngineMetrics,
  type EngineSnapshot,
  type EngineStatus,
  type MetricGroup,
} from '@/types/metrics'

function fullMetrics(overrides: Partial<EngineMetrics> = {}): EngineMetrics {
  return {
    tokens_per_sec: 100,
    avg_tokens_per_sec: 80,
    per_request_tps: 50,
    ttft_ms: 120,
    active_requests: 2,
    queued_requests: 1,
    kv_cache_percent: 40,
    kv_cache_is_estimated: false,
    total_requests: 10,
    e2e_latency_ms: 500,
    prompt_tokens_per_sec: 200,
    avg_prompt_tokens_per_sec: 180,
    per_request_prompt_tps: 70,
    swapped_requests: 0,
    prefix_cache_hit_rate: 30,
    queue_time_ms: 50,
    inter_token_latency_ms: 25,
    preemptions_total: 0,
    total_prompt_tokens: 1000,
    total_generation_tokens: 2000,
    prefix_cache_queries_total: 5000,
    avg_batch_size: 4,
    ttft_percentiles: null,
    itl_percentiles: null,
    e2e_percentiles: null,
    ttft_goodput_pct: null,
    itl_goodput_pct: null,
    e2e_goodput_pct: null,
    ttft_buckets: null,
    itl_buckets: null,
    e2e_buckets: null,
    tpot_ms: 28,
    tpot_percentiles: null,
    tpot_goodput_pct: null,
    tpot_buckets: null,
    spec_decode_draft_tokens_total: null,
    spec_decode_accepted_tokens_total: null,
    spec_decode_drafts_total: null,
    spec_decode_acceptance_rate: null,
    spec_decode_acceptance_rate_live: null,
    spec_decode_mean_acceptance_length: null,
    ...overrides,
  }
}

function engine(
  status: EngineStatus['type'],
  metrics: EngineMetrics | null = fullMetrics(),
  endpoint = 'http://localhost:8000',
  reporting: Pick<EngineSnapshot, 'metric_groups' | 'metrics_off'> = {},
): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint,
    status: status === 'Error' ? { type: 'Error', message: 'boom' } : { type: status },
    model: { name: 'test/model', parameter_size: null, quantization: null, precision: null, tensor_type: null, model_type: null, pipeline_tag: null },
    metrics,
    recent_requests: [],
    deployment_mode: 'Docker',
    ...reporting,
  }
}

/** A running engine that declares only `groups` — a non-vLLM engine. */
function reporting(metrics: EngineMetrics | null, groups: MetricGroup[]): EngineSnapshot {
  return engine('Running', metrics, 'http://localhost:8001', { metric_groups: groups })
}

/** Every group at `count` — the coverage of a host whose engines all report everything. */
function everyGroup(count: number): Record<MetricGroup, number> {
  return Object.fromEntries(METRIC_GROUPS.map((g) => [g, count])) as Record<MetricGroup, number>
}

describe('aggregateEngines', () => {
  it('returns empty snapshot with zero engines', () => {
    const snap = aggregateEngines([])
    expect(snap.running_count).toBe(0)
    expect(snap.total_count).toBe(0)
    expect(snap.tokens_per_sec).toBeNull()
    expect(snap.ttft_ms).toBeNull()
    expect(snap.kv_cache_percent).toBeNull()
  })

  it('counts Running separately from total', () => {
    const engines = [
      engine('Running'),
      engine('Stopped'),
      engine('Loading'),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.running_count).toBe(1)
    expect(snap.total_count).toBe(3)
  })

  it('sums additive fields across running engines only', () => {
    const engines = [
      engine('Running', fullMetrics({ tokens_per_sec: 100, active_requests: 2, total_requests: 10 })),
      engine('Running', fullMetrics({ tokens_per_sec: 150, active_requests: 3, total_requests: 20 })),
      engine('Stopped', fullMetrics({ tokens_per_sec: 999, active_requests: 999, total_requests: 999 })),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.tokens_per_sec).toBe(250)
    expect(snap.active_requests).toBe(5)
    expect(snap.total_requests).toBe(30)
  })

  it('sums cumulative token totals across running engines only', () => {
    const engines = [
      engine('Running', fullMetrics({ total_prompt_tokens: 1_000, total_generation_tokens: 5_000 })),
      engine('Running', fullMetrics({ total_prompt_tokens: 2_500, total_generation_tokens: 7_500 })),
      engine('Stopped', fullMetrics({ total_prompt_tokens: 999, total_generation_tokens: 999 })),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.total_prompt_tokens).toBe(3_500)
    expect(snap.total_generation_tokens).toBe(12_500)
  })

  it('sums cumulative prefix-cache queries across running engines only', () => {
    const engines = [
      engine('Running', fullMetrics({ prefix_cache_queries_total: 1_000 })),
      engine('Running', fullMetrics({ prefix_cache_queries_total: 2_500 })),
      engine('Stopped', fullMetrics({ prefix_cache_queries_total: 999 })),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.prefix_cache_queries_total).toBe(3_500)
  })

  it('returns null prefix-cache queries when every running engine reports null', () => {
    const engines = [
      engine('Running', fullMetrics({ prefix_cache_queries_total: null })),
      engine('Running', fullMetrics({ prefix_cache_queries_total: null })),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.prefix_cache_queries_total).toBeNull()
  })

  it('sums spec-decode counters and recomputes TAR/mean-length from the sums', () => {
    // Deliberately UNEQUAL draft volumes so the sum-weighted TAR cannot be
    // confused with a naive per-engine average:
    //   Engine A: 720 accepted / 800 draft / 200 draft-attempts (TAR 90%)
    //   Engine B:  20 accepted / 200 draft / 100 draft-attempts (TAR 10%)
    //   sum-derived TAR = 740/1000 = 74%   (naive mean of 90,10 would be 50%)
    //   mean acceptance length = 740/300 = 2.4667
    const engines = [
      engine(
        'Running',
        fullMetrics({
          spec_decode_accepted_tokens_total: 720,
          spec_decode_draft_tokens_total: 800,
          spec_decode_drafts_total: 200,
          spec_decode_acceptance_rate: 90,
        }),
      ),
      engine(
        'Running',
        fullMetrics({
          spec_decode_accepted_tokens_total: 20,
          spec_decode_draft_tokens_total: 200,
          spec_decode_drafts_total: 100,
          spec_decode_acceptance_rate: 10,
        }),
      ),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.spec_decode_accepted_tokens_total).toBe(740)
    expect(snap.spec_decode_draft_tokens_total).toBe(1_000)
    expect(snap.spec_decode_drafts_total).toBe(300)
    // 74, NOT the naive average of 90 and 10 (= 50).
    expect(snap.spec_decode_acceptance_rate).toBeCloseTo(74, 5)
    expect(snap.spec_decode_mean_acceptance_length).toBeCloseTo(740 / 300, 5)
  })

  it('blends live TAR weighted by each engine draft-token volume', () => {
    // Engine A: live 80%, 800 draft tokens; Engine B: live 20%, 200 draft.
    // Weighted mean = (80*800 + 20*200) / 1000 = 68.
    const engines = [
      engine(
        'Running',
        fullMetrics({
          spec_decode_acceptance_rate_live: 80,
          spec_decode_draft_tokens_total: 800,
        }),
      ),
      engine(
        'Running',
        fullMetrics({
          spec_decode_acceptance_rate_live: 20,
          spec_decode_draft_tokens_total: 200,
        }),
      ),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.spec_decode_acceptance_rate_live).toBeCloseTo(68, 5)
  })

  it('leaves spec-decode fields null when no running engine reports them', () => {
    const snap = aggregateEngines([engine('Running', fullMetrics())])
    expect(snap.spec_decode_draft_tokens_total).toBeNull()
    expect(snap.spec_decode_acceptance_rate).toBeNull()
    expect(snap.spec_decode_acceptance_rate_live).toBeNull()
    expect(snap.spec_decode_mean_acceptance_length).toBeNull()
  })

  it('weighted mean for latencies uses total_requests as the weight', () => {
    // Engine A: ttft 100ms, 10 requests; Engine B: ttft 500ms, 90 requests
    // Weighted mean = (100*10 + 500*90) / 100 = 460
    const engines = [
      engine('Running', fullMetrics({ ttft_ms: 100, total_requests: 10 })),
      engine('Running', fullMetrics({ ttft_ms: 500, total_requests: 90 })),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.ttft_ms).toBeCloseTo(460, 5)
  })

  it('weighted mean applies to inter-token latency', () => {
    // Engine A: ITL 20ms, 10 requests; Engine B: ITL 80ms, 40 requests
    // Weighted mean = (20*10 + 80*40) / 50 = 68
    const engines = [
      engine('Running', fullMetrics({ inter_token_latency_ms: 20, total_requests: 10 })),
      engine('Running', fullMetrics({ inter_token_latency_ms: 80, total_requests: 40 })),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.inter_token_latency_ms).toBeCloseTo(68, 5)
  })

  it('weighted mean falls back to simple mean when all weights are zero', () => {
    const engines = [
      engine('Running', fullMetrics({ ttft_ms: 100, total_requests: 0 })),
      engine('Running', fullMetrics({ ttft_ms: 300, total_requests: 0 })),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.ttft_ms).toBe(200)
  })

  it('weighted mean falls back to simple mean when all weights are null', () => {
    const engines = [
      engine('Running', fullMetrics({ ttft_ms: 100, total_requests: null })),
      engine('Running', fullMetrics({ ttft_ms: 300, total_requests: null })),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.ttft_ms).toBe(200)
  })

  it('simple mean for KV cache percent (not a sum)', () => {
    const engines = [
      engine('Running', fullMetrics({ kv_cache_percent: 30 })),
      engine('Running', fullMetrics({ kv_cache_percent: 60 })),
      engine('Running', fullMetrics({ kv_cache_percent: 90 })),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.kv_cache_percent).toBe(60)
  })

  it('skips null metric fields when aggregating', () => {
    const engines = [
      engine('Running', fullMetrics({ tokens_per_sec: 100 })),
      engine('Running', fullMetrics({ tokens_per_sec: null })),
      engine('Running', fullMetrics({ tokens_per_sec: 50 })),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.tokens_per_sec).toBe(150)
  })

  it('returns null for a field when every running engine reports null', () => {
    const engines = [
      engine('Running', fullMetrics({ prefix_cache_hit_rate: null })),
      engine('Running', fullMetrics({ prefix_cache_hit_rate: null })),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.prefix_cache_hit_rate).toBeNull()
  })

  it('handles engines with null metrics objects (waiting for first poll)', () => {
    const engines = [
      engine('Running', null),
      engine('Running', fullMetrics({ tokens_per_sec: 100 })),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.running_count).toBe(2)
    expect(snap.tokens_per_sec).toBe(100)
  })

  it('returns empty body when all engines are stopped but preserves total_count', () => {
    const engines = [
      engine('Stopped'),
      engine('Error'),
    ]
    const snap = aggregateEngines(engines)
    expect(snap.running_count).toBe(0)
    expect(snap.total_count).toBe(2)
    expect(snap.tokens_per_sec).toBeNull()
  })
})

describe('aggregateEngines over engines that report different metric groups', () => {
  const percentiles = (p50: number) => ({ p50_ms: p50, p95_ms: p50 * 2, p99_ms: p50 * 3 })

  it('combines a host of engines that report every group exactly as before', () => {
    // vLLM declares every group; a backend older than the declaration sends
    // none. Both must aggregate to the same figures as each other.
    const a = fullMetrics({ tokens_per_sec: 100, ttft_ms: 100, total_requests: 10, ttft_percentiles: percentiles(80), ttft_goodput_pct: 90 })
    const b = fullMetrics({ tokens_per_sec: 150, ttft_ms: 500, total_requests: 30, ttft_percentiles: percentiles(200), ttft_goodput_pct: 70, kv_cache_is_estimated: true })
    const undeclared = aggregateEngines([engine('Running', a), engine('Running', b, 'b')])
    const declared = aggregateEngines([
      engine('Running', a, 'a', { metric_groups: [...METRIC_GROUPS] }),
      engine('Running', b, 'b', { metric_groups: [...METRIC_GROUPS] }),
    ])

    expect(declared).toEqual(undeclared)
    expect(undeclared.tokens_per_sec).toBe(250)
    expect(undeclared.ttft_ms).toBeCloseTo(400, 5)
    expect(undeclared.kv_cache_is_estimated).toBe(true)
    expect(undeclared.coverage).toEqual({ running: 2, included: everyGroup(2) })
  })

  it('sums only the engines that report the group', () => {
    const snap = aggregateEngines([
      engine('Running', fullMetrics({ tokens_per_sec: 100 })),
      reporting(fullMetrics({ tokens_per_sec: 50 }), ['Requests']),
    ])

    expect(snap.tokens_per_sec).toBe(100)
    expect(snap.coverage.running).toBe(2)
    expect(snap.coverage.included.Throughput).toBe(1)
    expect(snap.coverage.included.Requests).toBe(2)
  })

  it('does not count a zero from an engine that reports nothing', () => {
    // An engine that reports no throughput is not an engine at 0 tok/s — a
    // mean over it would halve, and a sum would read as idle capacity.
    const snap = aggregateEngines([
      engine('Running', fullMetrics({ tokens_per_sec: 100, kv_cache_percent: 40 })),
      reporting(fullMetrics({ tokens_per_sec: 0, kv_cache_percent: 0 }), []),
    ])

    expect(snap.tokens_per_sec).toBe(100)
    expect(snap.kv_cache_percent).toBe(40)
    expect(snap.coverage.included).toEqual(everyGroup(1))
  })

  it('leaves out an engine whose metrics are off', () => {
    const snap = aggregateEngines([
      engine('Running', fullMetrics({ tokens_per_sec: 100 })),
      engine('Running', null, 'b', { metric_groups: [...METRIC_GROUPS], metrics_off: '--enable-metrics' }),
    ])

    expect(snap.tokens_per_sec).toBe(100)
    // Still running — it serves; it is only its metrics that are off.
    expect(snap.running_count).toBe(2)
    expect(snap.coverage).toEqual({ running: 2, included: everyGroup(1) })
  })

  it('reads a figure no running engine reports as null, not zero', () => {
    const snap = aggregateEngines([
      reporting(fullMetrics({ tokens_per_sec: 100 }), ['Requests']),
      reporting(fullMetrics({ tokens_per_sec: 50 }), ['KvCache']),
    ])

    expect(snap.tokens_per_sec).toBeNull()
    expect(snap.avg_batch_size).toBeNull()
    expect(snap.coverage.included.Throughput).toBe(0)
    expect(snap.coverage.running).toBe(2)
  })

  it('weights latencies by requests only over engines that report requests', () => {
    // B reports latencies but no request counts, so it has no weight to enter a
    // request-weighted mean with — and is not counted as included in it.
    const a = engine('Running', fullMetrics({
      ttft_ms: 100,
      queue_time_ms: 20,
      ttft_percentiles: percentiles(100),
      ttft_goodput_pct: 90,
      total_requests: 10,
    }))
    const b = (groups: MetricGroup[]) => reporting(fullMetrics({
      ttft_ms: 500,
      queue_time_ms: 80,
      ttft_percentiles: percentiles(500),
      ttft_goodput_pct: 10,
      total_requests: 90,
    }), groups)

    const means = aggregateEngines([a, b(['LatencyMeans'])])
    expect(means.ttft_ms).toBe(100)
    expect(means.coverage.included.LatencyMeans).toBe(1)

    const queue = aggregateEngines([a, b(['QueueTime'])])
    expect(queue.queue_time_ms).toBe(20)
    expect(queue.coverage.included.QueueTime).toBe(1)

    const tails = aggregateEngines([a, b(['LatencyPercentiles'])])
    expect(tails.ttft_percentiles).toEqual(percentiles(100))
    expect(tails.ttft_goodput_pct).toBe(90)
    expect(tails.coverage.included.LatencyPercentiles).toBe(1)

    // Reporting requests as well, B enters with its weight: (100·10 + 500·90) / 100.
    const weighted = aggregateEngines([a, b(['LatencyMeans', 'Requests'])])
    expect(weighted.ttft_ms).toBeCloseTo(460, 5)
    expect(weighted.coverage.included.LatencyMeans).toBe(2)
  })

  it('means a percentage over the engines that report it, and its estimate flag with it', () => {
    const snap = aggregateEngines([
      engine('Running', fullMetrics({ kv_cache_percent: 30, kv_cache_is_estimated: false })),
      reporting(fullMetrics({ kv_cache_percent: 60, kv_cache_is_estimated: true }), ['Throughput']),
    ])

    expect(snap.kv_cache_percent).toBe(30)
    // The estimated pool is not in the mean, so the mean is not an estimate.
    expect(snap.kv_cache_is_estimated).toBe(false)
    expect(aggregateEngineMetrics([
      engine('Running', fullMetrics({ kv_cache_is_estimated: false })),
      reporting(fullMetrics({ kv_cache_is_estimated: true }), ['Throughput']),
    ])!.kv_cache_is_estimated).toBe(false)
  })

  it('carries zero coverage when no engine is running', () => {
    expect(aggregateEngines([engine('Stopped')]).coverage).toEqual({
      running: 0,
      included: everyGroup(0),
    })
  })
})

describe('includedIn', () => {
  it('requires a request-weighted group to come with request counts', () => {
    expect(includedIn(reporting(null, ['LatencyMeans']), 'LatencyMeans')).toBe(false)
    expect(includedIn(reporting(null, ['LatencyMeans', 'Requests']), 'LatencyMeans')).toBe(true)
    expect(includedIn(reporting(null, ['LatencyPercentiles']), 'LatencyPercentiles')).toBe(false)
    expect(includedIn(reporting(null, ['QueueTime']), 'QueueTime')).toBe(false)
    // A sum or a plain mean needs no weight.
    expect(includedIn(reporting(null, ['KvCache']), 'KvCache')).toBe(true)
    expect(includedIn(reporting(null, ['Throughput']), 'Throughput')).toBe(true)
  })

  it('leaves out an engine that is not running, or whose metrics are off', () => {
    expect(includedIn(engine('Stopped'), 'Throughput')).toBe(false)
    expect(includedIn(engine('Running', null, 'a', { metrics_off: '--metrics' }), 'Throughput')).toBe(false)
  })
})

describe('aggregateCoverage', () => {
  it('counts per group the running engines a figure combines, by declaration', () => {
    const coverage = aggregateCoverage([
      // Running without a first sample yet — it still reports the groups.
      engine('Running', null),
      reporting(fullMetrics(), ['Throughput', 'KvCache']),
      engine('Stopped'),
    ])

    expect(coverage.running).toBe(2)
    expect(coverage.included.Throughput).toBe(2)
    expect(coverage.included.KvCache).toBe(2)
    expect(coverage.included.Requests).toBe(1)
    expect(coverage.included.PrefixCache).toBe(1)
  })
})

describe('panelCoverage', () => {
  it('keeps the panel’s groups that some engine reports, in the panel’s order', () => {
    const coverage = aggregateCoverage([
      engine('Running'),
      reporting(fullMetrics(), ['PrefixCache']),
      reporting(fullMetrics(), []),
    ])

    expect(panelCoverage(coverage, ['PrefixCache', 'SpeculativeDecoding', 'KvCache'])).toEqual({
      running: 3,
      groups: [
        { group: 'PrefixCache', included: 2 },
        { group: 'SpeculativeDecoding', included: 1 },
        { group: 'KvCache', included: 1 },
      ],
    })
    expect(
      panelCoverage(aggregateCoverage([reporting(fullMetrics(), ['Throughput'])]), ['KvCache', 'Throughput']),
    ).toEqual({ running: 1, groups: [{ group: 'Throughput', included: 1 }] })
  })
})

function engineWithModel(
  status: EngineStatus['type'],
  modelName: string | null,
  endpoint = 'http://localhost:8000',
): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint,
    status: status === 'Error' ? { type: 'Error', message: 'boom' } : { type: status },
    model: modelName === null ? null : { name: modelName, parameter_size: null, quantization: null, precision: null, tensor_type: null, model_type: null, pipeline_tag: null },
    metrics: null,
    recent_requests: [],
    deployment_mode: 'Docker',
  }
}

describe('aggregateEngineMetrics', () => {
  it('returns null when no engine is running', () => {
    // An aggregate over nothing is not a row of zeros.
    expect(aggregateEngineMetrics([])).toBeNull()
    expect(aggregateEngineMetrics([engine('Stopped')])).toBeNull()
  })

  it('reshapes the aggregate as one engine metrics object', () => {
    const engines = [
      engine('Running', fullMetrics({ tokens_per_sec: 100, tpot_ms: 20, total_requests: 10 })),
      engine('Running', fullMetrics({ tokens_per_sec: 150, tpot_ms: 40, total_requests: 30 })),
    ]
    const metrics = aggregateEngineMetrics(engines)!

    expect(metrics.tokens_per_sec).toBe(250)
    // Weighted mean by total_requests, like the other latencies: (20·10 + 40·30) / 40.
    expect(metrics.tpot_ms).toBe(35)
  })

  it('marks the KV figure estimated when any contributing pool is', () => {
    const engines = [
      engine('Running', fullMetrics({ kv_cache_is_estimated: false })),
      engine('Running', fullMetrics({ kv_cache_is_estimated: true })),
    ]
    expect(aggregateEngineMetrics(engines)!.kv_cache_is_estimated).toBe(true)
    expect(aggregateEngineMetrics([engine('Running')])!.kv_cache_is_estimated).toBe(false)
  })

  it('carries no histogram buckets, whose layouts differ per engine', () => {
    // The SLO panel falls back to the backend-computed goodput percentages,
    // which do aggregate — as weighted means.
    const metrics = aggregateEngineMetrics([
      engine('Running', fullMetrics({ ttft_buckets: [{ le_seconds: 1, cumulative_count: 5 }], ttft_goodput_pct: 90, itl_goodput_pct: 80 })),
    ])!

    expect(metrics.ttft_buckets).toBeNull()
    expect(metrics.itl_buckets).toBeNull()
    expect(metrics.e2e_buckets).toBeNull()
    expect(metrics.tpot_buckets).toBeNull()
    expect(metrics.ttft_goodput_pct).toBe(90)
    expect(metrics.itl_goodput_pct).toBe(80)
  })
})

describe('groupRunningByProvider', () => {
  it('returns [] for no engines', () => {
    expect(groupRunningByProvider([])).toEqual([])
  })

  it('groups two running engines from the same provider into one entry with count 2', () => {
    const groups = groupRunningByProvider([
      engineWithModel('Running', 'meta-llama/Llama-3.1-8B-Instruct', 'a'),
      engineWithModel('Running', 'meta-llama/Llama-3.2-3B-Instruct', 'b'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('meta')
    expect(groups[0].label).toBe('meta-llama')
    expect(groups[0].count).toBe(2)
    expect(groups[0].logo?.slug).toBe('meta')
  })

  it('ignores non-Running engines', () => {
    const groups = groupRunningByProvider([
      engineWithModel('Running', 'Qwen/Qwen2.5-7B-Instruct', 'a'),
      engineWithModel('Stopped', 'Qwen/Qwen2.5-14B', 'b'),
      engineWithModel('Loading', 'meta-llama/Llama-3.1-8B-Instruct', 'c'),
      engineWithModel('Error', 'OpenAI/gpt-oss', 'd'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('qwen')
    expect(groups[0].count).toBe(1)
  })

  it('sorts groups by count desc, then label asc', () => {
    const groups = groupRunningByProvider([
      engineWithModel('Running', 'Qwen/Qwen2.5-7B', 'a'),
      engineWithModel('Running', 'meta-llama/Llama-3.1-8B', 'b'),
      engineWithModel('Running', 'meta-llama/Llama-3.2-3B', 'c'),
      engineWithModel('Running', 'OpenAI/gpt-oss-20b', 'd'),
    ])
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ['meta', 2],
      ['openai', 1],
      ['qwen', 1],
    ])
  })

  it('falls back to raw org prefix with null logo for unrecognized providers', () => {
    const groups = groupRunningByProvider([
      engineWithModel('Running', 'some-random-org/weird-model', 'a'),
      engineWithModel('Running', 'some-random-org/other-model', 'b'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].logo).toBeNull()
    expect(groups[0].label).toBe('some-random-org')
    expect(groups[0].key).toBe('raw:some-random-org')
    expect(groups[0].count).toBe(2)
  })

  it('falls back to Unknown when the model has no name or no org prefix', () => {
    const groups = groupRunningByProvider([
      engineWithModel('Running', null, 'a'),
      engineWithModel('Running', 'totally-opaque-name', 'b'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('unknown')
    expect(groups[0].label).toBe('Unknown')
    expect(groups[0].logo).toBeNull()
    expect(groups[0].count).toBe(2)
  })
})
