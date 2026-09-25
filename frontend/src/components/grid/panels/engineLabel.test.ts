import { beforeEach, describe, expect, it } from 'vitest'
import { shortModelName } from '@/lib/format'
import { engineKey } from '@/lib/identity'
import { writeEngineLabel } from '@/lib/engineLabelStore'
import type { EngineSnapshot } from '@/types/metrics'
import { engineIdentity } from './engineLabel'
import type { ResolvedEngineTarget } from './useEnginePanel'

const MODEL = 'Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf'

function engine(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return {
    engine_type: 'LlamaCpp',
    endpoint: 'http://localhost:8098',
    status: { type: 'Running' },
    model: {
      name: MODEL,
      parameter_size: null,
      quantization: null,
      precision: null,
      tensor_type: null,
      model_type: null,
      pipeline_tag: null,
    },
    metrics: null,
    recent_requests: [],
    deployment_mode: 'Native',
    ...overrides,
  }
}

function resolved(target: EngineSnapshot): ResolvedEngineTarget {
  return { status: 'resolved', engine: target, multiEngine: true }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('engineIdentity label', () => {
  it('shows the shortened model path when no label is set', () => {
    expect(engineIdentity(resolved(engine())).model).toBe(shortModelName(MODEL))
  })

  it('shows the operator label in place of the raw model path', () => {
    const target = resolved(engine())
    writeEngineLabel(engineKey(target.engine), 'conf-qwen')
    expect(engineIdentity(target).model).toBe('conf-qwen')
  })

  it('shows no identity on a single-engine host, label or not', () => {
    const target: ResolvedEngineTarget = { status: 'resolved', engine: engine(), multiEngine: false }
    writeEngineLabel(engineKey(target.engine), 'conf-qwen')
    const identity = engineIdentity(target)
    expect(identity.label).toBeNull()
    expect(identity.model).toBeNull()
  })
})
