import { describe, expect, it } from 'vitest'
import {
  ALL_MODELS,
  pageSourceChoices,
  pageSourceFromChoice,
  readPageSource,
} from './pageSource'
import type { EngineSnapshot } from '@/types/metrics'

function engine(endpoint: string, model: string | null): EngineSnapshot {
  return {
    engine_type: 'Vllm',
    endpoint,
    status: { type: 'Running' },
    model: model
      ? {
          name: model,
          parameter_size: null,
          quantization: null,
          precision: null,
          tensor_type: null,
          model_type: null,
          pipeline_tag: null,
        }
      : null,
    metrics: null,
    recent_requests: [],
    deployment_mode: 'Native',
  }
}

describe('readPageSource', () => {
  it('reads the two stored kinds', () => {
    expect(readPageSource({ kind: 'all' })).toEqual({ kind: 'all' })
    expect(readPageSource({ kind: 'engine', endpoint: 'http://localhost:8000' })).toEqual({
      kind: 'engine',
      endpoint: 'http://localhost:8000',
    })
  })

  it('reads everything else as automatic', () => {
    expect(readPageSource(undefined)).toBeUndefined()
    expect(readPageSource(null)).toBeUndefined()
    expect(readPageSource('all')).toBeUndefined()
    expect(readPageSource({ kind: 'engine' })).toBeUndefined()
    expect(readPageSource({ kind: 'engine', endpoint: '' })).toBeUndefined()
    expect(readPageSource({ kind: 'everything' })).toBeUndefined()
  })
})

describe('pageSourceChoices', () => {
  const engines = [
    engine('http://localhost:8000', 'Qwen/Qwen3-8B'),
    engine('http://localhost:8001', null),
  ]

  it('offers automatic, all models, and every engine, named by its model', () => {
    const { value, choices } = pageSourceChoices(undefined, engines)

    expect(value).toBe('auto')
    expect(choices.map((choice) => choice.label)).toEqual([
      'Automatic — first serving model',
      'All models — combined',
      'Qwen3-8B — vLLM localhost:8000',
      'No model loaded — vLLM localhost:8001',
    ])
  })

  it('selects the stored source', () => {
    expect(pageSourceChoices(ALL_MODELS, engines).value).toBe('all')
    expect(
      pageSourceChoices({ kind: 'engine', endpoint: 'http://localhost:8001' }, engines).value,
    ).toBe('engine:http://localhost:8001')
  })

  it('keeps a configured engine that is not on this host, marked absent', () => {
    // Hiding it is how a page would silently end up showing something else.
    const { value, choices } = pageSourceChoices(
      { kind: 'engine', endpoint: 'http://localhost:9999' },
      engines,
    )

    expect(value).toBe('engine:http://localhost:9999')
    expect(choices.at(-1)).toEqual({
      value: 'engine:http://localhost:9999',
      label: 'http://localhost:9999 (not on this host)',
      absent: true,
    })
  })

  it('round-trips every choice it offers', () => {
    const { choices } = pageSourceChoices(undefined, engines)

    expect(pageSourceFromChoice(choices[0].value)).toBeNull()
    expect(pageSourceFromChoice(choices[1].value)).toEqual({ kind: 'all' })
    expect(pageSourceFromChoice(choices[2].value)).toEqual({
      kind: 'engine',
      endpoint: 'http://localhost:8000',
    })
  })
})

describe('pageSourceFromChoice', () => {
  it('reads anything outside the grammar as automatic', () => {
    expect(pageSourceFromChoice('auto')).toBeNull()
    expect(pageSourceFromChoice('engine:')).toBeNull()
    expect(pageSourceFromChoice('gpu:0')).toBeNull()
    expect(pageSourceFromChoice('')).toBeNull()
  })
})
