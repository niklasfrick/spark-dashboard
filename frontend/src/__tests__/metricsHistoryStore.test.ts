import { describe, expect, it, vi } from 'vitest'
import { MetricsHistoryStore } from '../lib/metricsHistoryStore'
import type { EngineSnapshot, MetricsSnapshot } from '../types/metrics'

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
    gpu: {
      index: 0,
      name: 'GPU 0',
      utilization_percent: util,
      memory_total_bytes: 24,
      memory_used_bytes: 6,
      temperature_celsius: temp,
      power_watts: 100,
      power_limit_watts: 300,
      clock_graphics_mhz: 1800,
      clock_sm_mhz: 1800,
      clock_memory_mhz: 9000,
      fan_speed_percent: 30,
    },
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
