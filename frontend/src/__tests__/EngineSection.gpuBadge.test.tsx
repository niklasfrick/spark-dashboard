import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EngineSection } from '../components/engines/EngineSection'
import type { EngineSnapshot } from '../types/metrics'

/** Minimal engine snapshot; header chips render even while metrics are null. */
function engine(gpuIndexes: number[] | undefined): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint: 'http://localhost:8000',
    status: { type: 'Running' },
    model: {
      name: 'test/model',
      parameter_size: null,
      quantization: null,
      precision: null,
      tensor_type: null,
      model_type: null,
      pipeline_tag: null,
    },
    metrics: null,
    recent_requests: [],
    deployment_mode: 'Docker',
    gpu_indexes: gpuIndexes,
  }
}

describe('EngineSection GPU badge', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('shows the GPU badge on a multi-GPU host when the engine is placed', () => {
    render(<EngineSection engines={[engine([1])]} gpuCount={2} />)
    expect(screen.getByText('GPU 1')).toBeTruthy()
  })

  it('joins indexes for an engine spanning multiple GPUs', () => {
    render(<EngineSection engines={[engine([0, 1])]} gpuCount={2} />)
    expect(screen.getByText('GPU 0+1')).toBeTruthy()
  })

  it('hides the badge on a single-GPU host even when placement is known', () => {
    render(<EngineSection engines={[engine([0])]} gpuCount={1} />)
    expect(screen.queryByText('GPU 0')).toBeNull()
  })

  it('hides the badge when placement is unknown (empty or absent indexes)', () => {
    const { unmount } = render(<EngineSection engines={[engine([])]} gpuCount={2} />)
    expect(screen.queryByText(/^GPU /)).toBeNull()
    unmount()

    render(<EngineSection engines={[engine(undefined)]} gpuCount={2} />)
    expect(screen.queryByText(/^GPU /)).toBeNull()
  })
})
