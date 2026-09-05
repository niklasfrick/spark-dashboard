import { describe, expect, it, vi } from 'vitest'
import {
  ALL_ENGINES_KEY,
  engineSeries,
  gpuMemoryPercent,
  gpuSeries,
  MetricsHistoryStore,
} from '../lib/metricsHistoryStore'
import type { EngineSnapshot, GpuMetrics, MetricsSnapshot } from '../types/metrics'

/** The GPU the snapshots below carry, for the specs that read one field of it. */
const GPU: GpuMetrics = {
  index: 0,
  name: 'GPU 0',
  utilization_percent: 11,
  memory_total_bytes: 24,
  memory_used_bytes: 6,
  temperature_celsius: 40,
  power_watts: 100,
  power_limit_watts: 300,
  clock_graphics_mhz: 1800,
  clock_sm_mhz: 1800,
  clock_memory_mhz: 9000,
  fan_speed_percent: 30,
}

/** A snapshot at `ts` whose per-series values can be nulled out selectively. */
function makeSnapshot(
  ts: number,
  overrides: {
    util?: number | null
    temp?: number | null
    engines?: EngineSnapshot[]
    gpu_events?: MetricsSnapshot['gpu_events']
  } = {},
): MetricsSnapshot {
  const { util = 11, temp = 40, engines = [], gpu_events = [] } = overrides
  return {
    timestamp_ms: ts,
    gpu: { ...GPU, utilization_percent: util, temperature_celsius: temp },
    cpu: { name: 'CPU', aggregate_percent: 25, per_core: [] },
    memory: {
      total_bytes: 128,
      display_total_bytes: 128,
      used_bytes: 64,
      available_bytes: 64,
      cached_bytes: 8,
      gpu_estimated_bytes: null,
      gpu_memory_total_bytes: null,
      gpu_memory_used_bytes: null,
      is_unified: false,
    },
    disk: { name: 'disk', read_bytes_per_sec: 1, write_bytes_per_sec: 2 },
    network: { name: 'net', rx_bytes_per_sec: 3, tx_bytes_per_sec: 4 },
    engines,
    gpu_events,
  }
}

/** An engine whose only live series is tokens/sec; everything else is null. */
function makeEngine(tps: number | null): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint: 'http://localhost:8000',
    status: { type: 'Running' },
    model: null,
    metrics: {
      tokens_per_sec: tps,
      avg_tokens_per_sec: null,
      per_request_tps: null,
      ttft_ms: null,
      active_requests: null,
      queued_requests: null,
      kv_cache_percent: null,
      kv_cache_is_estimated: false,
      total_requests: null,
      e2e_latency_ms: null,
      prompt_tokens_per_sec: null,
      avg_prompt_tokens_per_sec: null,
      per_request_prompt_tps: null,
      swapped_requests: null,
      prefix_cache_hit_rate: null,
      queue_time_ms: null,
      inter_token_latency_ms: null,
      preemptions_total: null,
      total_prompt_tokens: null,
      total_generation_tokens: null,
      prefix_cache_queries_total: null,
      avg_batch_size: null,
      ttft_percentiles: null,
      itl_percentiles: null,
      e2e_percentiles: null,
      ttft_goodput_pct: null,
      itl_goodput_pct: null,
      e2e_goodput_pct: null,
      ttft_buckets: null,
      itl_buckets: null,
      e2e_buckets: null,
      tpot_ms: null,
      tpot_percentiles: null,
      tpot_goodput_pct: null,
      tpot_buckets: null,
      spec_decode_draft_tokens_total: null,
      spec_decode_accepted_tokens_total: null,
      spec_decode_drafts_total: null,
      spec_decode_acceptance_rate: null,
      spec_decode_acceptance_rate_live: null,
      spec_decode_mean_acceptance_length: null,
    },
    recent_requests: [],
    deployment_mode: 'Native',
    gpu_indexes: [],
  }
}

describe('MetricsHistoryStore windowed reads', () => {
  it('returns more retained samples for a fifteen-minute window than a five-minute one', () => {
    const store = new MetricsHistoryStore()
    // 601 samples one second apart; the buffers retain all of them.
    for (let i = 1; i <= 601; i++) {
      store.ingest(makeSnapshot(i * 1000))
    }

    const fiveMin = store.getChartData('gpuUtil', '5m')
    const fifteenMin = store.getChartData('gpuUtil', '15m')
    expect(fiveMin.length).toBe(301) // now − 300s, inclusive
    expect(fifteenMin.length).toBe(601) // window exceeds retained history
    expect(fifteenMin.length).toBeGreaterThan(fiveMin.length)

    // The window applies to every series family the same way.
    expect(store.getChartData('gpu:0:gpuUtil', '15m').length).toBeGreaterThan(
      store.getChartData('gpu:0:gpuUtil', '5m').length,
    )

    // Omitting the window reads the default five minutes.
    expect(store.getChartData('gpuUtil')).toEqual(fiveMin)
  })

  it('windows engine series and events the same way', () => {
    const store = new MetricsHistoryStore()
    for (let i = 1; i <= 601; i++) {
      store.ingest(
        makeSnapshot(i * 1000, {
          engines: [makeEngine(i)],
          gpu_events:
            i % 60 === 0
              ? [{ timestamp_ms: i * 1000, gpu_index: 0, event_type: 'thermal', detail: `t${i}` }]
              : [],
        }),
      )
    }

    const engineSeries = 'Vllm-http://localhost:8000:tps'
    expect(store.getChartData(engineSeries, '15m').length).toBeGreaterThan(
      store.getChartData(engineSeries, '5m').length,
    )
    expect(store.getEvents('15m').length).toBeGreaterThan(store.getEvents('5m').length)
  })
})

describe('MetricsHistoryStore all-engines aggregate series', () => {
  it('ingests the combined series alongside the per-engine ones', () => {
    const store = new MetricsHistoryStore()
    store.ingest(
      makeSnapshot(1_000, {
        engines: [makeEngine(100), { ...makeEngine(150), endpoint: 'http://localhost:8001' }],
      }),
    )

    // The sum, under its own key — what a page configured for all models charts…
    expect(store.getChartData(engineSeries('tps', ALL_ENGINES_KEY), '15m')).toEqual([
      { timestamp: 1_000, value: 250 },
    ])
    // …with the per-engine series untouched beside it.
    expect(store.getChartData('Vllm-http://localhost:8000:tps', '15m')).toEqual([
      { timestamp: 1_000, value: 100 },
    ])
  })

  it('notifies a subscriber of the aggregate series', () => {
    const store = new MetricsHistoryStore()
    const listener = vi.fn()
    store.subscribe(engineSeries('tps', ALL_ENGINES_KEY), listener)

    store.ingest(makeSnapshot(1_000, { engines: [makeEngine(100)] }))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ingests no aggregate sample when no engine is running', () => {
    const store = new MetricsHistoryStore()
    store.ingest(
      makeSnapshot(1_000, { engines: [{ ...makeEngine(100), status: { type: 'Stopped' } }] }),
    )

    expect(store.getChartData(engineSeries('tps', ALL_ENGINES_KEY), '15m')).toEqual([])
  })
})

describe('MetricsHistoryStore per-series subscriptions', () => {
  it('notifies only the series a snapshot changed', () => {
    const store = new MetricsHistoryStore()
    store.ingest(makeSnapshot(1000))

    const utilListener = vi.fn()
    const tempListener = vi.fn()
    store.subscribe('gpuUtil', utilListener)
    store.subscribe('gpuTemp', tempListener)
    const tempVersion = store.seriesVersion('gpuTemp')

    // Temperature is null: that series receives no sample this snapshot.
    store.ingest(makeSnapshot(2000, { util: 12, temp: null }))

    expect(utilListener).toHaveBeenCalledTimes(1)
    expect(tempListener).not.toHaveBeenCalled()
    expect(store.seriesVersion('gpuUtil')).toBeGreaterThan(0)
    expect(store.seriesVersion('gpuTemp')).toBe(tempVersion)
    expect(store.getChartData('gpuUtil').map((p) => p.value)).toEqual([11, 12])
    expect(store.getChartData('gpuTemp').map((p) => p.value)).toEqual([40])
  })

  it('stops notifying after unsubscribe', () => {
    const store = new MetricsHistoryStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe('gpuUtil', listener)
    store.ingest(makeSnapshot(1000))
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    store.ingest(makeSnapshot(2000))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores a snapshot with an already-ingested timestamp', () => {
    const store = new MetricsHistoryStore()
    const listener = vi.fn()
    store.subscribeAll(listener)
    store.ingest(makeSnapshot(1000))
    store.ingest(makeSnapshot(1000, { util: 99 }))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getChartData('gpuUtil').map((p) => p.value)).toEqual([11])
  })

  it('notifies whole-store subscribers on every ingested snapshot', () => {
    const store = new MetricsHistoryStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribeAll(listener)
    const before = store.ingestVersion()

    store.ingest(makeSnapshot(1000))
    store.ingest(makeSnapshot(2000))
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.ingestVersion()).toBe(before + 2)

    unsubscribe()
    store.ingest(makeSnapshot(3000))
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('MetricsHistoryStore latest snapshot', () => {
  it('holds nothing before the first ingest and the newest snapshot after', () => {
    const store = new MetricsHistoryStore()
    expect(store.latest()).toBeNull()

    store.ingest(makeSnapshot(1000))
    store.ingest(makeSnapshot(2000, { util: 55 }))
    expect(store.latest()?.gpu.utilization_percent).toBe(55)
  })

  it('keeps the accepted snapshot when a duplicate timestamp is replayed', () => {
    const store = new MetricsHistoryStore()
    store.ingest(makeSnapshot(1000))
    store.ingest(makeSnapshot(1000, { util: 99 }))

    expect(store.latest()?.gpu.utilization_percent).toBe(11)
  })
})

describe('gpuSeries', () => {
  it('prefixes the GPU index on multi-GPU hosts', () => {
    expect(gpuSeries('gpuUtil', 1, true)).toBe('gpu:1:gpuUtil')
  })

  it('keeps the legacy un-prefixed key on single-GPU hosts', () => {
    expect(gpuSeries('gpuTemp', 0, false)).toBe('gpuTemp')
  })

  it('names series the store actually resolves', () => {
    const store = new MetricsHistoryStore()
    store.ingest(makeSnapshot(1000))

    expect(store.getChartData(gpuSeries('gpuUtil', 0, true)).map((p) => p.value)).toEqual([11])
    expect(store.getChartData(gpuSeries('gpuUtil', 0, false)).map((p) => p.value)).toEqual([11])
  })

  it('charts a GPU’s own memory and fan on both key shapes', () => {
    // The two series behind the GPU Memory and GPU Fan panels (#110), which
    // resolve their keys through `gpuSeries` like every other GPU panel.
    const store = new MetricsHistoryStore()
    store.ingest(makeSnapshot(1000))

    // 6 of 24 bytes used, charted as the percentage the gauge shows.
    expect(store.getChartData('gpuMemory').map((p) => p.value)).toEqual([25])
    expect(store.getChartData(gpuSeries('gpuMemory', 0, true)).map((p) => p.value)).toEqual([25])
    expect(store.getChartData('gpuFan').map((p) => p.value)).toEqual([30])
    expect(store.getChartData(gpuSeries('gpuFan', 0, true)).map((p) => p.value)).toEqual([30])
  })
})

describe('gpuMemoryPercent', () => {
  it('is the used share of the device’s own pool', () => {
    expect(gpuMemoryPercent({ ...GPU, memory_used_bytes: 6, memory_total_bytes: 24 })).toBe(25)
  })

  it('is absent on a GPU that reports no pool of its own', () => {
    // The unified-memory SoCs: NVML answers NotSupported, and the host memory
    // panel is the one with the numbers. A zero here would be a lie.
    expect(gpuMemoryPercent({ ...GPU, memory_total_bytes: null })).toBeNull()
    expect(gpuMemoryPercent({ ...GPU, memory_used_bytes: null })).toBeNull()
    expect(gpuMemoryPercent({ ...GPU, memory_total_bytes: undefined })).toBeNull()
  })

  it('does not divide by a pool of zero bytes', () => {
    expect(gpuMemoryPercent({ ...GPU, memory_total_bytes: 0 })).toBeNull()
  })
})
