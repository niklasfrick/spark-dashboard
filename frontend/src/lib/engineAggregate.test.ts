import { describe, it, expect } from 'vitest'
import { aggregateEngines, groupRunningByProvider } from './engineAggregate'
import type { EngineMetrics, EngineSnapshot, EngineStatus } from '@/types/metrics'

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
    preemptions_total: 0,
    avg_batch_size: 4,
    ...overrides,
  }
}

function engine(
  status: EngineStatus['type'],
  metrics: EngineMetrics | null = fullMetrics(),
  endpoint = 'http://localhost:8000',
): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint,
    status: status === 'Error' ? { type: 'Error', message: 'boom' } : { type: status },
    model: { name: 'test/model', parameter_size: null, quantization: null },
    metrics,
    recent_requests: [],
    deployment_mode: 'Docker',
  }
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

function engineWithModel(
  status: EngineStatus['type'],
  modelName: string | null,
  endpoint = 'http://localhost:8000',
): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint,
    status: status === 'Error' ? { type: 'Error', message: 'boom' } : { type: status },
    model: modelName === null ? null : { name: modelName, parameter_size: null, quantization: null },
    metrics: null,
    recent_requests: [],
    deployment_mode: 'Docker',
  }
}

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
