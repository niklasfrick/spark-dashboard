import { describe, expect, it } from 'vitest'
import {
  NO_SELECTION,
  pageSelection,
  withSelectedEngine,
  withSelectedGpu,
} from './selection'
import { ALL_MODELS } from './pageSource'
import type { EngineSnapshot, GpuMetrics, MetricsSnapshot } from '@/types/metrics'

function gpu(index: number | null): GpuMetrics {
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

function engine(endpoint: string, status: EngineSnapshot['status'] = { type: 'Running' }): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint,
    status,
    model: null,
    metrics: null,
    recent_requests: [],
    deployment_mode: 'Native',
  }
}

function snapshot(gpus: GpuMetrics[], engines: EngineSnapshot[]): Pick<
  MetricsSnapshot,
  'gpu' | 'gpus' | 'engines'
> {
  return { gpu: gpus[0], gpus, engines }
}

describe('pageSelection', () => {
  it('follows the primary GPU and the running engine when nothing is chosen or configured', () => {
    // This is what makes the shipped preset work unmodified on any machine.
    const host = snapshot([gpu(0), gpu(1)], [engine('http://localhost:8000')])

    expect(pageSelection(host, {})).toEqual({
      gpuIndex: 0,
      engineTarget: { kind: 'engine', endpoint: 'http://localhost:8000' },
    })
  })

  it('prefers a running engine over a stopped one listed first', () => {
    const host = snapshot(
      [gpu(0)],
      [engine('http://localhost:8000', { type: 'Stopped' }), engine('http://localhost:8001')],
    )

    expect(pageSelection(host, {}).engineTarget).toEqual({
      kind: 'engine',
      endpoint: 'http://localhost:8001',
    })
  })

  it('falls back to the first engine when none is running', () => {
    const host = snapshot(
      [gpu(0)],
      [
        engine('http://localhost:8000', { type: 'Loading' }),
        engine('http://localhost:8001', { type: 'Stopped' }),
      ],
    )

    expect(pageSelection(host, {}).engineTarget).toEqual({
      kind: 'engine',
      endpoint: 'http://localhost:8000',
    })
  })

  it('normalizes the index of a GPU reported without one', () => {
    expect(pageSelection(snapshot([gpu(null)], []), {}).gpuIndex).toBe(0)
  })

  it('selects nothing for an engine the host is not running', () => {
    // Engine panels degrade to an empty state here; the hardware panels beside
    // them keep working, which is the point.
    expect(pageSelection(snapshot([gpu(0)], []), {}).engineTarget).toBeNull()
  })

  it('resolves a page configured for one engine to that engine', () => {
    const host = snapshot(
      [gpu(0)],
      [engine('http://localhost:8000'), engine('http://localhost:8001')],
    )

    expect(
      pageSelection(host, {}, { kind: 'engine', endpoint: 'http://localhost:8001' }).engineTarget,
    ).toEqual({ kind: 'engine', endpoint: 'http://localhost:8001' })
  })

  it('resolves a page configured for all models to the aggregate', () => {
    const host = snapshot([gpu(0)], [engine('http://localhost:8000')])

    expect(pageSelection(host, {}, ALL_MODELS).engineTarget).toEqual({ kind: 'all' })
  })

  it('keeps a configured engine whose target has gone away', () => {
    // Panels report it as missing. Nudging the page back to whatever is
    // running would hide from the operator that the engine their page names
    // has stopped — and would show its numbers under the other engine's name.
    const host = snapshot([gpu(0)], [engine('http://localhost:8000')])

    expect(
      pageSelection(host, {}, { kind: 'engine', endpoint: 'http://localhost:9999' }).engineTarget,
    ).toEqual({ kind: 'engine', endpoint: 'http://localhost:9999' })
  })

  it('honours what the operator chose over the host defaults', () => {
    const host = snapshot(
      [gpu(0), gpu(1)],
      [engine('http://localhost:8000'), engine('http://localhost:8001')],
    )

    expect(
      pageSelection(host, { gpuIndex: 1, engineEndpoint: 'http://localhost:8001' }),
    ).toEqual({ gpuIndex: 1, engineTarget: { kind: 'engine', endpoint: 'http://localhost:8001' } })
  })

  it('honours a session choice over the configured source', () => {
    // The source is the page's default; a choice made while looking at the
    // page is the operator asking to see something else right now.
    const host = snapshot(
      [gpu(0)],
      [engine('http://localhost:8000'), engine('http://localhost:8001')],
    )

    expect(
      pageSelection(host, { engineEndpoint: 'http://localhost:8000' }, ALL_MODELS).engineTarget,
    ).toEqual({ kind: 'engine', endpoint: 'http://localhost:8000' })
  })

  it('keeps a choice whose target has gone away', () => {
    const host = snapshot([gpu(0)], [engine('http://localhost:8000')])

    expect(pageSelection(host, { gpuIndex: 3, engineEndpoint: 'http://localhost:9999' })).toEqual({
      gpuIndex: 3,
      engineTarget: { kind: 'engine', endpoint: 'http://localhost:9999' },
    })
  })

  it('has nothing to select before the first snapshot', () => {
    expect(pageSelection(null, {})).toEqual(NO_SELECTION)
  })

  it('keeps a choice made before the first snapshot arrives', () => {
    expect(pageSelection(null, { gpuIndex: 1 })).toEqual({
      gpuIndex: 1,
      engineTarget: null,
    })
  })

  it('resolves a configured source before the first snapshot arrives', () => {
    // A page configured for all models must not flash the host default while
    // the socket connects.
    expect(pageSelection(null, {}, ALL_MODELS).engineTarget).toEqual({ kind: 'all' })
  })
})

describe('choosing what a page points at', () => {
  it('records a chosen GPU and engine', () => {
    expect(withSelectedGpu({}, 2)).toEqual({ gpuIndex: 2 })
    expect(withSelectedEngine({ gpuIndex: 2 }, 'http://localhost:8000')).toEqual({
      gpuIndex: 2,
      engineEndpoint: 'http://localhost:8000',
    })
  })

  it('goes back to following the host when the choice is cleared', () => {
    // Absent means "never chose", which is what a cleared selection has to
    // become — storing a null would freeze the page on a host that changes.
    expect(withSelectedGpu({ gpuIndex: 2, engineEndpoint: 'http://x:1' }, null)).toEqual({
      engineEndpoint: 'http://x:1',
    })
    expect(withSelectedEngine({ gpuIndex: 2, engineEndpoint: 'http://x:1' }, null)).toEqual({
      gpuIndex: 2,
    })
  })

  it('leaves the selection it was given untouched', () => {
    const chosen = { gpuIndex: 0 }
    withSelectedGpu(chosen, 1)
    expect(chosen).toEqual({ gpuIndex: 0 })
  })
})
