import { describe, expect, it } from 'vitest'
import type { EngineIdentity } from '@/lib/identity'
import { FOLLOW, UNREADABLE, type PanelBinding } from './bindings'
import { bindingChoices, bindingFromChoice } from './bindingChoices'

const GPUS = [
  { index: 0, name: 'NVIDIA GB10' },
  { index: 1, name: 'NVIDIA GB10' },
]

// Two engines of the one type the backend detects, which is also the case a
// pin exists for: same provider, different port.
const ENGINES: EngineIdentity[] = [
  { engine_type: 'Vllm', endpoint: 'http://localhost:8000' },
  { engine_type: 'Vllm', endpoint: 'http://localhost:8001' },
]

const values = (binding: PanelBinding, kind: 'gpu' | 'engine' | 'none' = 'gpu') =>
  bindingChoices(kind, binding, GPUS, ENGINES).choices.map((choice) => choice.value)

describe('what a GPU panel can be pointed at', () => {
  it('offers the page selection and every GPU on the host', () => {
    expect(values(FOLLOW)).toEqual(['follow', 'gpu:0', 'gpu:1'])
  })

  it('marks the one the panel is bound to as selected', () => {
    const control = bindingChoices('gpu', { kind: 'gpu', index: 1 }, GPUS, ENGINES)

    expect(control.value).toBe('gpu:1')
    expect(control.choices.map((choice) => choice.absent)).not.toContain(true)
  })

  it('names the GPU, so the operator picks a card rather than a number', () => {
    const [, first] = bindingChoices('gpu', FOLLOW, GPUS, ENGINES).choices

    expect(first.label).toContain('GPU 0')
    expect(first.label).toContain('NVIDIA GB10')
  })
})

describe('what an engine panel can be pointed at', () => {
  it('offers the page selection and every engine on the host', () => {
    expect(values(FOLLOW, 'engine')).toEqual([
      'follow',
      'engine:http://localhost:8000',
      'engine:http://localhost:8001',
    ])
  })

  it('names each engine the way the rest of the dashboard does', () => {
    const [, first] = bindingChoices('engine', FOLLOW, GPUS, ENGINES).choices

    expect(first.label).toContain('vLLM')
    expect(first.label).toContain('8000')
  })
})

describe('a panel bound to something that is not here', () => {
  it('keeps offering the GPU it is pinned to, marked as absent', () => {
    // Dropping the option would leave the select showing some other GPU while
    // the panel is still pinned to this one — the prohibited failure, made
    // permanent by the next edit.
    const control = bindingChoices('gpu', { kind: 'gpu', index: 3 }, GPUS, ENGINES)

    expect(control.value).toBe('gpu:3')
    expect(control.choices.at(-1)).toMatchObject({ value: 'gpu:3', absent: true })
    expect(control.choices.at(-1)?.label).toContain('GPU 3')
  })

  it('keeps offering the engine it is pinned to, marked as absent', () => {
    const gone = 'http://localhost:9999'
    const control = bindingChoices('engine', { kind: 'engine', endpoint: gone }, GPUS, ENGINES)

    expect(control.value).toBe(`engine:${gone}`)
    expect(control.choices.at(-1)).toMatchObject({ absent: true })
    expect(control.choices.at(-1)?.label).toContain(gone)
  })
})

describe('a binding the document could not offer', () => {
  it('shows a panel whose binding could not be read as needing a target', () => {
    const control = bindingChoices('gpu', UNREADABLE, GPUS, ENGINES)

    expect(control.value).toBe('unreadable')
    expect(control.choices[0]).toMatchObject({ value: 'unreadable', absent: true })
    // Everything else is still on offer: repointing is how the panel is
    // repaired.
    expect(control.choices.map((choice) => choice.value)).toContain('gpu:0')
  })

  it('treats a binding of the wrong kind the same way', () => {
    // An engine binding on a GPU panel is a corrupt document. Resolving it to
    // some GPU anyway is what must never happen, here as much as at render.
    expect(
      bindingChoices('gpu', { kind: 'engine', endpoint: 'http://localhost:8000' }, GPUS, ENGINES)
        .value,
    ).toBe('unreadable')
  })
})

describe('a panel that binds to nothing', () => {
  it('is offered no choices at all', () => {
    // Host-wide panels cover the whole machine; there is nothing to pin.
    expect(bindingChoices('none', FOLLOW, GPUS, ENGINES).choices).toEqual([])
  })
})

describe('a host with nothing to bind to', () => {
  it('still offers the page selection, so the control is never empty', () => {
    expect(bindingChoices('engine', FOLLOW, [], []).choices.map((c) => c.value)).toEqual(['follow'])
  })
})

describe('reading a choice back', () => {
  it('round-trips every choice the control offers', () => {
    for (const binding of [
      FOLLOW,
      { kind: 'gpu', index: 1 } as const,
      { kind: 'engine', endpoint: 'http://localhost:8001' } as const,
    ]) {
      const kind = binding.kind === 'engine' ? 'engine' : 'gpu'
      expect(bindingFromChoice(bindingChoices(kind, binding, GPUS, ENGINES).value)).toEqual(binding)
    }
  })

  it('reads an endpoint that has colons of its own', () => {
    expect(bindingFromChoice('engine:http://localhost:8000')).toEqual({
      kind: 'engine',
      endpoint: 'http://localhost:8000',
    })
  })

  it('refuses to guess at anything else', () => {
    // Including the unreadable option itself, which is shown to say what the
    // panel is, not to be chosen.
    expect(bindingFromChoice('unreadable')).toEqual(UNREADABLE)
    expect(bindingFromChoice('gpu:')).toEqual(UNREADABLE)
    expect(bindingFromChoice('nonsense')).toEqual(UNREADABLE)
  })
})
