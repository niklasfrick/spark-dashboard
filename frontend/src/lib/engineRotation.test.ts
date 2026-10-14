import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENGINE_ROTATION,
  ROTATION_INTERVALS,
  engineRotationLabel,
  nextRotationTarget,
  parseEngineRotation,
  rotationCycle,
  rotationTargetKey,
  serializeEngineRotation,
} from './engineRotation'
import type { EngineSnapshot } from '@/types/metrics'

const ALPHA = 'http://localhost:8000'
const BETA = 'http://localhost:8001'
const GAMMA = 'http://localhost:8002'

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

describe('the engine rotation setting', () => {
  it('offers the old carousel’s four intervals', () => {
    expect(ROTATION_INTERVALS).toEqual([3000, 5000, 10000, 20000])
  })

  it('is off by default', () => {
    // The old carousel was on by default; on a page whose source is one
    // engine, an unrequested rotation would be a surprise.
    expect(DEFAULT_ENGINE_ROTATION).toBeNull()
    expect(parseEngineRotation(null)).toBeNull()
    expect(parseEngineRotation(undefined)).toBeNull()
  })

  it('round-trips off and every interval through storage', () => {
    for (const setting of [null, ...ROTATION_INTERVALS]) {
      expect(parseEngineRotation(serializeEngineRotation(setting))).toBe(setting)
    }
    expect(serializeEngineRotation(null)).toBe('off')
    expect(serializeEngineRotation(5000)).toBe('5000')
  })

  it('reads anything it did not write as off', () => {
    // Off, not the nearest interval: a setting that cannot be read is not a
    // request to start moving the page.
    for (const raw of ['', '0', '4000', '-3000', 'fast', '10000ms', 'NaN']) {
      expect(parseEngineRotation(raw)).toBeNull()
    }
  })

  it('names each setting the way the control shows it', () => {
    expect(engineRotationLabel(null)).toBe('Off')
    expect(ROTATION_INTERVALS.map(engineRotationLabel)).toEqual(['3 s', '5 s', '10 s', '20 s'])
  })
})

describe('the rotation cycle', () => {
  it('is all models, then each running engine in snapshot order', () => {
    expect(rotationCycle([engine(BETA), engine(ALPHA)])).toEqual([
      { kind: 'all' },
      { kind: 'engine', endpoint: BETA },
      { kind: 'engine', endpoint: ALPHA },
    ])
  })

  it('leaves out engines that are not serving', () => {
    expect(
      rotationCycle([
        engine(ALPHA),
        engine(BETA, { type: 'Stopped' }),
        engine(GAMMA),
      ]),
    ).toEqual([
      { kind: 'all' },
      { kind: 'engine', endpoint: ALPHA },
      { kind: 'engine', endpoint: GAMMA },
    ])
  })

  it('is empty with fewer than two engines running', () => {
    // One engine and the combination of one engine are the same numbers.
    expect(rotationCycle([])).toEqual([])
    expect(rotationCycle([engine(ALPHA)])).toEqual([])
    expect(rotationCycle([engine(ALPHA), engine(BETA, { type: 'Loading' })])).toEqual([])
  })
})

describe('the next step', () => {
  const cycle = rotationCycle([engine(ALPHA), engine(BETA)])

  it('walks all models, each engine, and back to all models', () => {
    let target = nextRotationTarget(cycle, { kind: 'all' })
    expect(target).toEqual({ kind: 'engine', endpoint: ALPHA })

    target = nextRotationTarget(cycle, target)
    expect(target).toEqual({ kind: 'engine', endpoint: BETA })

    target = nextRotationTarget(cycle, target)
    expect(target).toEqual({ kind: 'all' })
  })

  it('rejoins the cycle at all models from a target it does not hold', () => {
    // An engine that stopped, a source naming one that is gone, or a page that
    // has resolved nothing yet.
    expect(nextRotationTarget(cycle, { kind: 'engine', endpoint: GAMMA })).toEqual({ kind: 'all' })
    expect(nextRotationTarget(cycle, null)).toEqual({ kind: 'all' })
  })

  it('picks up an engine that started since the last step', () => {
    const grown = rotationCycle([engine(ALPHA), engine(BETA), engine(GAMMA)])

    expect(nextRotationTarget(grown, { kind: 'engine', endpoint: BETA })).toEqual({
      kind: 'engine',
      endpoint: GAMMA,
    })
  })

  it('has nowhere to go in an empty cycle', () => {
    expect(nextRotationTarget([], { kind: 'all' })).toBeNull()
  })
})

describe('telling targets apart', () => {
  it('gives each target its own key', () => {
    expect(rotationTargetKey(null)).toBe('none')
    expect(rotationTargetKey({ kind: 'all' })).toBe('all')
    expect(rotationTargetKey({ kind: 'engine', endpoint: ALPHA })).toBe(`engine:${ALPHA}`)
  })
})
