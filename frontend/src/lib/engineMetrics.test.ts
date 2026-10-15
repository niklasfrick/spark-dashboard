import { describe, expect, it } from 'vitest'
import {
  contributesGroup,
  engineAvailability,
  engineMetricReader,
  METRIC_FIELD_GROUP,
  metricGroupOf,
  reportedMetricGroups,
  reportsMetrics,
  type EngineReadable,
} from './engineMetrics'
import { METRIC_GROUPS, type EngineMetrics } from '@/types/metrics'

function metrics(overrides: Partial<EngineMetrics> = {}): EngineMetrics {
  return {
    tokens_per_sec: 120,
    avg_tokens_per_sec: 100,
    per_request_tps: 40,
    ttft_ms: 210,
    active_requests: 3,
    queued_requests: 1,
    kv_cache_percent: 42,
    kv_cache_is_estimated: false,
    total_requests: 900,
    e2e_latency_ms: 4200,
    prompt_tokens_per_sec: 3000,
    avg_prompt_tokens_per_sec: 2500,
    per_request_prompt_tps: 800,
    swapped_requests: 0,
    prefix_cache_hit_rate: 55,
    queue_time_ms: 12,
    inter_token_latency_ms: 9,
    preemptions_total: 0,
    total_prompt_tokens: 1_000_000,
    total_generation_tokens: 500_000,
    prefix_cache_queries_total: 2_000_000,
    avg_batch_size: 6.5,
    ttft_percentiles: { p50_ms: 200, p95_ms: 400, p99_ms: 900 },
    itl_percentiles: null,
    e2e_percentiles: null,
    ttft_goodput_pct: 99,
    itl_goodput_pct: 98,
    e2e_goodput_pct: 97,
    ttft_buckets: null,
    itl_buckets: null,
    e2e_buckets: null,
    tpot_ms: 8,
    tpot_percentiles: null,
    tpot_goodput_pct: 96,
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

function engine(overrides: Partial<EngineReadable> = {}): EngineReadable {
  return {
    status: { type: 'Running' },
    model: { name: 'Qwen/Qwen3-8B' } as EngineReadable['model'],
    metrics: metrics(),
    ...overrides,
  }
}

describe('engineMetricReader', () => {
  it('reads the fields an engine reports', () => {
    const read = engineMetricReader(engine())

    expect(read('tokens_per_sec')).toBe(120)
    expect(read('ttft_percentiles')).toEqual({ p50_ms: 200, p95_ms: 400, p99_ms: 900 })
  })

  it('reads an absent metric as no value', () => {
    const read = engineMetricReader(engine({ metrics: metrics({ tokens_per_sec: null }) }))

    expect(read('tokens_per_sec')).toBeNull()
    expect(read('itl_percentiles')).toBeNull()
  })

  it('reads nothing at all from an engine with no model loaded', () => {
    // Its last metrics describe a model it is no longer serving; rendering them
    // would put a finished run's numbers under an idle engine's name.
    const read = engineMetricReader(engine({ model: null }))

    expect(read('tokens_per_sec')).toBeNull()
    expect(read('total_requests')).toBeNull()
  })
})

describe('engineAvailability', () => {
  it('is ready when the engine is serving a model and reporting', () => {
    expect(engineAvailability(engine())).toEqual({ kind: 'ready' })
  })

  it('separates an engine that is starting from one that is not running', () => {
    // The first resolves itself in a second; the second needs the operator to
    // do something. A grid of dashes would say neither.
    expect(engineAvailability(engine({ metrics: null }))).toEqual({ kind: 'starting' })
    expect(engineAvailability(engine({ status: { type: 'Loading' }, metrics: null }))).toEqual({
      kind: 'starting',
    })
    expect(engineAvailability(engine({ status: { type: 'Stopped' } }))).toEqual({
      kind: 'offline',
      detail: 'is not running.',
    })
  })

  it('carries an engine’s own error message', () => {
    expect(
      engineAvailability(engine({ status: { type: 'Error', message: 'connection refused' } })),
    ).toEqual({ kind: 'offline', detail: 'reported an error: connection refused' })
  })

  it('reports an engine with no model as offline rather than starting', () => {
    expect(engineAvailability(engine({ model: null }))).toEqual({
      kind: 'offline',
      detail: 'has no model loaded.',
    })
  })
})

describe('reportedMetricGroups', () => {
  it('reads the groups the backend declared for the engine', () => {
    const groups = reportedMetricGroups({ metric_groups: ['Throughput', 'ItlMean'] })

    expect([...groups].sort()).toEqual(['ItlMean', 'Throughput'])
    expect(groups.has('ItlPercentiles')).toBe(false)
  })

  it('reads an engine that declared nothing as reporting nothing', () => {
    expect(reportedMetricGroups({ metric_groups: [] }).size).toBe(0)
  })

  it('reads a backend older than the field as reporting every group', () => {
    // That backend filled every panel; an upgraded frontend in front of it
    // must not turn them all into placeholders.
    expect([...reportedMetricGroups({})]).toEqual([...METRIC_GROUPS])
    expect(reportedMetricGroups({}).size).toBe(17)
  })
})

describe('METRIC_GROUPS', () => {
  it('names the groups exactly as the backend serializes them', () => {
    // The mirror of `MetricGroup` in `src/engines/mod.rs`, whose wire-name
    // spec pins the same seventeen strings in the same order.
    expect(METRIC_GROUPS).toEqual([
      'Throughput',
      'BatchSize',
      'ActiveRequests',
      'RequestTotal',
      'Preemptions',
      'QueueTime',
      'KvCache',
      'PrefixCache',
      'SpeculativeDecoding',
      'TtftMean',
      'TtftPercentiles',
      'E2eMean',
      'E2ePercentiles',
      'ItlMean',
      'ItlPercentiles',
      'TpotMean',
      'TpotPercentiles',
    ])
  })
})

describe('METRIC_FIELD_GROUP', () => {
  it('places every engine metric in one of the metric groups', () => {
    const keys = Object.keys(metrics()) as Array<keyof EngineMetrics>

    for (const key of keys) {
      expect(METRIC_GROUPS, key).toContain(METRIC_FIELD_GROUP[key])
      expect(metricGroupOf(key)).toBe(METRIC_FIELD_GROUP[key])
    }
    // …and names no field the metrics do not carry.
    expect(Object.keys(METRIC_FIELD_GROUP).sort()).toEqual([...keys].sort())
  })

  it('leaves no metric group without a field', () => {
    const owned = new Set(Object.values(METRIC_FIELD_GROUP))

    for (const group of METRIC_GROUPS) expect(owned.has(group), group).toBe(true)
  })

  it('files each field with the group a tile keys on', () => {
    expect(metricGroupOf('avg_batch_size')).toBe('BatchSize')
    expect(metricGroupOf('per_request_tps')).toBe('TpotMean')
    expect(metricGroupOf('per_request_prompt_tps')).toBe('TtftMean')
    expect(metricGroupOf('swapped_requests')).toBe('Preemptions')
    expect(metricGroupOf('preemptions_total')).toBe('Preemptions')
    expect(metricGroupOf('total_requests')).toBe('RequestTotal')
    expect(metricGroupOf('active_requests')).toBe('ActiveRequests')
    expect(metricGroupOf('queued_requests')).toBe('ActiveRequests')
    expect(metricGroupOf('tpot_ms')).toBe('TpotMean')
    expect(metricGroupOf('ttft_ms')).toBe('TtftMean')
    expect(metricGroupOf('e2e_goodput_pct')).toBe('E2ePercentiles')
    expect(metricGroupOf('itl_buckets')).toBe('ItlPercentiles')
    expect(metricGroupOf('queue_time_ms')).toBe('QueueTime')
    expect(metricGroupOf('tokens_per_sec')).toBe('Throughput')
    expect(metricGroupOf('kv_cache_is_estimated')).toBe('KvCache')
    expect(metricGroupOf('prefix_cache_queries_total')).toBe('PrefixCache')
    expect(metricGroupOf('spec_decode_acceptance_rate_live')).toBe('SpeculativeDecoding')
  })
})

describe('contributesGroup', () => {
  const running = { status: { type: 'Running' } } as const

  it('counts a running engine that declares the group', () => {
    expect(contributesGroup({ ...running, metric_groups: ['KvCache'] }, 'KvCache')).toBe(true)
  })

  it('counts a running engine from a backend older than the declaration', () => {
    expect(contributesGroup(running, 'KvCache')).toBe(true)
  })

  it('leaves out an engine that is not running', () => {
    for (const status of [
      { type: 'Stopped' },
      { type: 'Loading' },
      { type: 'Error', message: 'boom' },
    ] as const) {
      expect(contributesGroup({ status }, 'Throughput'), status.type).toBe(false)
    }
  })

  it('leaves out an engine that does not declare the group', () => {
    expect(contributesGroup({ ...running, metric_groups: ['Throughput'] }, 'KvCache')).toBe(false)
  })

  it('leaves out an engine whose metrics are off, whatever it declares', () => {
    expect(
      contributesGroup(
        { ...running, metric_groups: [...METRIC_GROUPS], metrics_off: '--enable-metrics' },
        'Throughput',
      ),
    ).toBe(false)
  })
})

describe('reportsMetrics', () => {
  it('reads an engine that declares nothing as reporting no metrics', () => {
    expect(reportsMetrics({ metric_groups: [] })).toBe(false)
  })

  it('reads an engine whose metrics are off as reporting no metrics', () => {
    expect(reportsMetrics({ metrics_off: '--metrics' })).toBe(false)
  })

  it('reads a backend older than the declaration as reporting metrics', () => {
    expect(reportsMetrics({})).toBe(true)
  })

  it('reads an engine that declares some groups as reporting metrics', () => {
    expect(reportsMetrics({ metric_groups: ['Throughput'] })).toBe(true)
  })
})
