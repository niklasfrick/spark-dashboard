import { describe, expect, it } from 'vitest'
import { engineAvailability, engineMetricReader, type EngineReadable } from './engineMetrics'
import type { EngineMetrics } from '@/types/metrics'

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
