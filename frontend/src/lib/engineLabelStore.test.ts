import { beforeEach, describe, expect, it } from 'vitest'
import { readEngineLabel, writeEngineLabel } from './engineLabelStore'

const A = 'LlamaCpp-http://localhost:8098'
const B = 'Vllm-http://localhost:8086'

beforeEach(() => {
  window.localStorage.clear()
})

describe('engine label store', () => {
  it('reads a label that is not set as null', () => {
    expect(readEngineLabel(A)).toBeNull()
  })

  it('persists a label and reads it back', () => {
    writeEngineLabel(A, 'conf-qwen')
    expect(readEngineLabel(A)).toBe('conf-qwen')
  })

  it('keeps labels separate per engine', () => {
    writeEngineLabel(A, 'conf-qwen')
    writeEngineLabel(B, 'nvfp4')
    expect(readEngineLabel(A)).toBe('conf-qwen')
    expect(readEngineLabel(B)).toBe('nvfp4')
  })

  it('trims whitespace and clears on an empty value', () => {
    writeEngineLabel(A, '  conf-qwen  ')
    expect(readEngineLabel(A)).toBe('conf-qwen')
    writeEngineLabel(A, '   ')
    expect(readEngineLabel(A)).toBeNull()
  })

  it('ignores a write with no engine key', () => {
    expect(() => writeEngineLabel(null, 'ignored')).not.toThrow()
    expect(readEngineLabel(null)).toBeNull()
  })
})
