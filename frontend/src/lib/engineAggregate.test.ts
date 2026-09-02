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
): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint,
    status: status === 'Error' ? { type: 'Error', message: 'boom' } : { type: status },
    model: { name: 'test/model', parameter_size: null, quantization: null, precision: null, tensor_type: null, model_type: null, pipeline_tag: null },
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
