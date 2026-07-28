import { describe, it, expect } from 'vitest'
import {
  engineKey,
  findEngineByEndpoint,
  findEngineByKey,
  findGpuByIndex,
  gpuIndexOf,
  snapshotGpus,
} from './identity'
import type { EngineSnapshot, GpuMetrics, MetricsSnapshot } from '@/types/metrics'

function engine(endpoint: string): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint,
    status: { type: 'Running' },
    model: null,
    metrics: null,
    recent_requests: [],
    deployment_mode: 'Docker',
  }
}

function gpu(overrides: Partial<GpuMetrics> = {}): GpuMetrics {
  return {
    name: 'NVIDIA GB10',
    utilization_percent: 10,
    temperature_celsius: 40,
    power_watts: 50,
    power_limit_watts: null,
    clock_graphics_mhz: null,
    clock_sm_mhz: null,
    clock_memory_mhz: null,
    fan_speed_percent: null,
    ...overrides,
  }
}

function snapshot(gpus: GpuMetrics[] | undefined, primary: GpuMetrics): Pick<MetricsSnapshot, 'gpu' | 'gpus'> {
  return { gpu: primary, gpus }
}

describe('engineKey', () => {
  it('composes the engine type and endpoint', () => {
    expect(engineKey(engine('http://localhost:8000'))).toBe('Vllm-http://localhost:8000')
  })

  it('separates engines of the same type on different endpoints', () => {
    expect(engineKey(engine('http://localhost:8000'))).not.toBe(
      engineKey(engine('http://localhost:8001')),
    )
  })

  it('accepts anything carrying the identity fields', () => {
    expect(engineKey({ engine_type: 'Vllm', endpoint: 'http://host:1' })).toBe(
      'Vllm-http://host:1',
    )
  })
})

describe('findEngineByKey', () => {
  const engines = [engine('http://localhost:8000'), engine('http://localhost:8001')]

  it('finds the engine whose key matches', () => {
    expect(findEngineByKey(engines, 'Vllm-http://localhost:8001')).toBe(engines[1])
  })

  it('returns undefined for a key no engine carries', () => {
    expect(findEngineByKey(engines, 'Vllm-http://localhost:9999')).toBeUndefined()
  })

  it('returns undefined for an absent key rather than guessing', () => {
    expect(findEngineByKey(engines, null)).toBeUndefined()
    expect(findEngineByKey(engines, undefined)).toBeUndefined()
  })
})

describe('findEngineByEndpoint', () => {
  const engines = [engine('http://localhost:8000'), engine('http://localhost:8001')]

  it('finds the engine bound to the endpoint', () => {
    expect(findEngineByEndpoint(engines, 'http://localhost:8000')).toBe(engines[0])
  })

  it('returns undefined when the bound engine is gone', () => {
    expect(findEngineByEndpoint(engines, 'http://localhost:9999')).toBeUndefined()
  })

  it('returns undefined for an absent endpoint', () => {
    expect(findEngineByEndpoint(engines, null)).toBeUndefined()
    expect(findEngineByEndpoint(engines, undefined)).toBeUndefined()
  })
})

describe('gpuIndexOf', () => {
  it('reads an explicit index', () => {
    expect(gpuIndexOf(gpu({ index: 3 }))).toBe(3)
    expect(gpuIndexOf(gpu({ index: 0 }))).toBe(0)
  })

  it('treats an absent index as the primary GPU', () => {
    expect(gpuIndexOf(gpu())).toBe(0)
  })

  it('treats a null index as the primary GPU', () => {
    expect(gpuIndexOf(gpu({ index: null }))).toBe(0)
  })
})

describe('snapshotGpus', () => {
  it('returns the per-GPU list when the backend ships one', () => {
    const gpus = [gpu({ index: 0 }), gpu({ index: 1 })]
    expect(snapshotGpus(snapshot(gpus, gpus[0]))).toEqual(gpus)
  })

  it('falls back to the single `gpu` field on legacy snapshots', () => {
    const primary = gpu({ index: null })
    expect(snapshotGpus(snapshot(undefined, primary))).toEqual([primary])
  })

  it('falls back to the single `gpu` field when the list is empty', () => {
    const primary = gpu()
    expect(snapshotGpus(snapshot([], primary))).toEqual([primary])
  })

  it('always yields at least one GPU', () => {
    expect(snapshotGpus(snapshot(undefined, gpu())).length).toBeGreaterThan(0)
  })
})

describe('findGpuByIndex', () => {
  it('finds a GPU by its explicit index', () => {
    const gpus = [gpu({ index: 0 }), gpu({ index: 1 })]
    expect(findGpuByIndex(gpus, 1)).toBe(gpus[1])
  })

  it('matches the normalized index of a legacy GPU', () => {
    const gpus = [gpu({ index: null })]
    expect(findGpuByIndex(gpus, 0)).toBe(gpus[0])
    expect(findGpuByIndex([gpu()], 0)).toBeDefined()
  })

  it('returns undefined when the index is not in the list', () => {
    expect(findGpuByIndex([gpu({ index: 0 })], 2)).toBeUndefined()
  })
})
