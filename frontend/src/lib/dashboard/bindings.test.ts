import { describe, it, expect } from 'vitest'
import {
  FOLLOW,
  UNREADABLE,
  readBinding,
  resolveEngineBinding,
  resolveGpuBinding,
} from './bindings'
import type { EngineSnapshot, GpuMetrics } from '@/types/metrics'

function gpu(index: number | null | undefined): GpuMetrics {
  return {
    index,
    name: 'NVIDIA GB10',
    utilization_percent: 10,
    memory_total_bytes: null,
    memory_used_bytes: null,
    temperature_celsius: 40,
    power_watts: 50,
    power_limit_watts: null,
    clock_graphics_mhz: null,
    clock_sm_mhz: null,
    clock_memory_mhz: null,
    fan_speed_percent: null,
  }
}

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

describe('readBinding', () => {
  it('reads the follow sentinel', () => {
    expect(readBinding({ kind: 'follow' })).toEqual(FOLLOW)
  })

  it('reads a GPU pinned by index', () => {
    expect(readBinding({ kind: 'gpu', index: 2 })).toEqual({ kind: 'gpu', index: 2 })
    expect(readBinding({ kind: 'gpu', index: 0 })).toEqual({ kind: 'gpu', index: 0 })
  })

  it('reads an engine pinned by endpoint', () => {
    expect(readBinding({ kind: 'engine', endpoint: 'http://localhost:8000' })).toEqual({
      kind: 'engine',
      endpoint: 'http://localhost:8000',
    })
  })

  it('defaults an absent binding to follow', () => {
    // Nothing was ever pinned, so following the page is the default rather than
    // a substitution for something the operator chose.
    expect(readBinding(undefined)).toEqual(FOLLOW)
    expect(readBinding(null)).toEqual(FOLLOW)
  })

  it('refuses to guess at a pin it cannot read', () => {
    // Reverting these to follow would show the page selection under a title the
    // operator may have written to name the target that was pinned here.
    expect(readBinding({ kind: 'gpu' })).toEqual(UNREADABLE)
    expect(readBinding({ kind: 'gpu', index: '2' })).toEqual(UNREADABLE)
    expect(readBinding({ kind: 'engine' })).toEqual(UNREADABLE)
    expect(readBinding({ kind: 'engine', endpoint: '' })).toEqual(UNREADABLE)
    expect(readBinding({ kind: 'display' })).toEqual(UNREADABLE)
    expect(readBinding('gpu:2')).toEqual(UNREADABLE)
    expect(readBinding(7)).toEqual(UNREADABLE)
  })

  it('rejects a GPU index that is not a real index', () => {
    expect(readBinding({ kind: 'gpu', index: -1 })).toEqual(UNREADABLE)
    expect(readBinding({ kind: 'gpu', index: 1.5 })).toEqual(UNREADABLE)
    expect(readBinding({ kind: 'gpu', index: NaN })).toEqual(UNREADABLE)
  })
})

describe('resolveGpuBinding', () => {
  const gpus = [gpu(0), gpu(1)]

  it('follows the page selection', () => {
    expect(resolveGpuBinding(FOLLOW, gpus, 1)).toEqual({ status: 'resolved', target: gpus[1] })
  })

  it('resolves a pinned GPU that is present', () => {
    expect(resolveGpuBinding({ kind: 'gpu', index: 0 }, gpus, 1)).toEqual({
      status: 'resolved',
      target: gpus[0],
    })
  })

  it('resolves a pin against the normalized index of a legacy GPU', () => {
    const legacy = [gpu(null)]
    expect(resolveGpuBinding({ kind: 'gpu', index: 0 }, legacy, 0)).toEqual({
      status: 'resolved',
      target: legacy[0],
    })
  })

  it('reports a pinned GPU that is not on the host as missing', () => {
    // Restricting the dashboard to one GPU has to make the panels pinned to the
    // others fail visibly, not quietly show GPU 0's numbers.
    expect(resolveGpuBinding({ kind: 'gpu', index: 3 }, gpus, 0)).toEqual({
      status: 'missing',
      requested: 'GPU 3',
    })
  })

  it('reports a followed selection that is not on the host as missing', () => {
    expect(resolveGpuBinding(FOLLOW, gpus, 3)).toEqual({ status: 'missing', requested: 'GPU 3' })
  })

  it('reports an empty host as having nothing selected', () => {
    expect(resolveGpuBinding(FOLLOW, [], 0)).toEqual({ status: 'unselected' })
  })

  it('still reports a pin against an empty host as missing', () => {
    // A pin named something specific, so it is missing rather than unselected —
    // "nothing to follow" is only a state a following panel can be in.
    expect(resolveGpuBinding({ kind: 'gpu', index: 3 }, [], 0)).toEqual({
      status: 'missing',
      requested: 'GPU 3',
    })
  })

  it('shows no GPU at all for a binding it could not read', () => {
    expect(resolveGpuBinding(UNREADABLE, gpus, 0)).toEqual({ status: 'unreadable' })
  })

  it('never substitutes a GPU for a binding that names an engine', () => {
    // On a GPU panel that is a corrupt document, and picking a GPU to show
    // anyway is the worst way to report it.
    expect(
      resolveGpuBinding({ kind: 'engine', endpoint: 'http://localhost:8000' }, gpus, 0),
    ).toEqual({ status: 'unreadable' })
  })
})

describe('resolveEngineBinding', () => {
  const engines = [engine('http://localhost:8000'), engine('http://localhost:8001')]

  it('follows the page selection', () => {
    expect(resolveEngineBinding(FOLLOW, engines, 'http://localhost:8001')).toEqual({
      status: 'resolved',
      target: engines[1],
    })
  })

  it('resolves a pinned engine that is running', () => {
    expect(
      resolveEngineBinding({ kind: 'engine', endpoint: 'http://localhost:8000' }, engines, null),
    ).toEqual({ status: 'resolved', target: engines[0] })
  })

  it('reports a pinned engine that is gone as missing', () => {
    // Changing an engine's port must show immediately which panels now point at
    // nothing, so they can be repointed.
    expect(
      resolveEngineBinding({ kind: 'engine', endpoint: 'http://localhost:9999' }, engines, null),
    ).toEqual({ status: 'missing', requested: 'http://localhost:9999' })
  })

  it('reports a followed selection that is gone as missing', () => {
    expect(resolveEngineBinding(FOLLOW, engines, 'http://localhost:9999')).toEqual({
      status: 'missing',
      requested: 'http://localhost:9999',
    })
  })

  it('reports a host running no engines as having nothing selected', () => {
    // Hardware monitoring stays useful on a host with no engines, so this is a
    // graceful state rather than a failure.
    expect(resolveEngineBinding(FOLLOW, [], null)).toEqual({ status: 'unselected' })
    expect(resolveEngineBinding(FOLLOW, engines, null)).toEqual({ status: 'unselected' })
  })

  it('shows no engine at all for a binding it could not read', () => {
    expect(resolveEngineBinding(UNREADABLE, engines, null)).toEqual({ status: 'unreadable' })
  })

  it('never substitutes an engine for a binding that names a GPU', () => {
    expect(resolveEngineBinding({ kind: 'gpu', index: 1 }, engines, null)).toEqual({
      status: 'unreadable',
    })
  })
})
