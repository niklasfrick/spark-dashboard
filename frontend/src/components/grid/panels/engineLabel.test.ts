import { describe, expect, it } from 'vitest'
import { HF_QWEN, TINYLLAMA, ollamaEngine } from '@/test/ollama'
import type { EngineSnapshot } from '@/types/metrics'
import { engineIdentity } from './engineLabel'

/** The identity row a metric panel wears for `engine` on a multi-engine host. */
function row(engine: EngineSnapshot) {
  return engineIdentity({ status: 'resolved', engine, multiEngine: true })
}

// The row names an engine by its model first. An Ollama engine has a list in
// place of one model, so the row reads it on the label and logo rules (#132).
describe('engineIdentity for an Ollama engine', () => {
  it('says an idle engine has no model loaded, and marks no provider', () => {
    expect(row(ollamaEngine([]))).toEqual({
      label: 'Ollama localhost:11434',
      model: 'No model loaded',
      logo: null,
      modelWarning: null,
      coverage: null,
    })
  })

  it('names the one model it holds, marked only when its name spells out a provider', () => {
    expect(row(ollamaEngine([TINYLLAMA]))).toMatchObject({
      model: 'tinyllama:latest',
      logo: null,
    })
    expect(row(ollamaEngine([HF_QWEN]))).toMatchObject({
      model: 'Qwen3-8B-GGUF:Q4_K_M',
      logo: { slug: 'qwen' },
    })
  })

  it('names several by the first and how many more, under no one provider', () => {
    expect(row(ollamaEngine([HF_QWEN, TINYLLAMA]))).toMatchObject({
      label: 'Ollama localhost:11434',
      model: 'Qwen3-8B-GGUF:Q4_K_M +1 more',
      logo: null,
    })
  })

  it('wears no row on a host running only this engine, like any other', () => {
    expect(
      engineIdentity({ status: 'resolved', engine: ollamaEngine([TINYLLAMA]), multiEngine: false }),
    ).toEqual({ label: null, model: null, logo: null, modelWarning: null, coverage: null })
  })
})
