import { describe, it, expect } from 'vitest'
import {
  formatAge,
  formatBytes,
  formatCompactTokens,
  formatAcceptanceLength,
  formatEndpoint,
  engineDescription,
  engineDisplayName,
  engineIconSrc,
  shortGpuName,
  modelMetadataWarning,
} from '../lib/format'

const GIB = 1_073_741_824
const MIB = 1_048_576

describe('formatBytes', () => {
  it('uses binary GiB under the "GB" label', () => {
    expect(formatBytes(2 * GIB)).toBe('2.0 GB')
  })

  it('uses binary MiB under the "MB" label', () => {
    expect(formatBytes(5 * MIB)).toBe('5.0 MB')
  })

  it('falls back to KB below 1 MiB', () => {
    expect(formatBytes(2048)).toBe('2.0 KB')
  })
})

describe('formatCompactTokens', () => {
  it('renders -- for null, negative, or non-finite', () => {
    expect(formatCompactTokens(null)).toBe('--')
    expect(formatCompactTokens(-5)).toBe('--')
    expect(formatCompactTokens(Number.NaN)).toBe('--')
  })

  it('shows raw integers below 1000', () => {
    expect(formatCompactTokens(0)).toBe('0')
    expect(formatCompactTokens(999)).toBe('999')
    expect(formatCompactTokens(999.6)).toBe('1000')
  })

  it('abbreviates with K/M/B/T and trims trailing .0', () => {
    expect(formatCompactTokens(1000)).toBe('1K')
    expect(formatCompactTokens(1234)).toBe('1.2K')
    expect(formatCompactTokens(1_000_000)).toBe('1M')
    expect(formatCompactTokens(1_250_000_000)).toBe('1.3B')
    expect(formatCompactTokens(3.4e12)).toBe('3.4T')
  })
})

describe('formatAcceptanceLength', () => {
  it('renders -- for null, negative, or non-finite', () => {
    expect(formatAcceptanceLength(null)).toBe('--')
    expect(formatAcceptanceLength(-1)).toBe('--')
    expect(formatAcceptanceLength(Number.NaN)).toBe('--')
    expect(formatAcceptanceLength(Number.POSITIVE_INFINITY)).toBe('--')
  })

  it('formats accepted-tokens-per-draft to two decimals', () => {
    expect(formatAcceptanceLength(3)).toBe('3.00')
    expect(formatAcceptanceLength(3.4167)).toBe('3.42')
    expect(formatAcceptanceLength(0)).toBe('0.00')
  })
})

describe('formatEndpoint', () => {
  it('keeps the host and port an operator configured', () => {
    expect(formatEndpoint('http://localhost:8000')).toBe('localhost:8000')
    expect(formatEndpoint('https://gpu-node-2.internal:8443/v1')).toBe('gpu-node-2.internal:8443')
  })

  it('keeps a default port that the URL leaves implicit', () => {
    // Two engines can differ only by scheme, so dropping the host would be
    // worse than showing no port.
    expect(formatEndpoint('http://localhost')).toBe('localhost')
  })

  it('falls back to the endpoint as stored when it is not a URL', () => {
    // The operator has to be able to match the label against their config,
    // whatever shape the endpoint came in.
    expect(formatEndpoint('localhost:8000')).toBe('localhost:8000')
    expect(formatEndpoint('')).toBe('')
  })
})

describe('formatAge', () => {
  it('reads in the coarsest unit that still says when', () => {
    expect(formatAge(59_000, 60_000)).toBe('1s')
    expect(formatAge(0, 59_000)).toBe('59s')
    expect(formatAge(0, 60_000)).toBe('1m')
    expect(formatAge(0, 59 * 60_000)).toBe('59m')
    expect(formatAge(0, 60 * 60_000)).toBe('1h')
  })

  it('rounds down, so nothing reads as older than it is', () => {
    expect(formatAge(0, 1999)).toBe('1s')
  })

  it('does not go negative on an event stamped past the newest sample', () => {
    // Snapshots coalesce, so an event can carry a timestamp the reference
    // reading has not caught up to yet.
    expect(formatAge(5000, 1000)).toBe('0s')
  })
})

describe('engineDescription', () => {
  it('names the provider and the instance', () => {
    // Both halves are needed: a host can run several engines of one provider,
    // which is exactly when a panel has to say which one it shows.
    expect(engineDescription({ engine_type: 'Vllm', endpoint: 'http://localhost:8001' })).toBe(
      'vLLM localhost:8001',
    )
  })
})

describe('modelMetadataWarning', () => {
  it('warns only on the auth rejection, which the operator can fix dashboard-side', () => {
    expect(modelMetadataWarning('AuthRequired')).toBe(
      'Engine requires authentication — configure the provider API key to read the model name.',
    )
  })

  it('stays silent for every non-auth reason', () => {
    // A merely unreachable /v1/models is already told by the engine status,
    // and a key would not help — warning here would send an operator fixing
    // the wrong thing. Absent covers older backends without the field.
    expect(modelMetadataWarning('Unavailable')).toBeNull()
    expect(modelMetadataWarning(null)).toBeNull()
    expect(modelMetadataWarning(undefined)).toBeNull()
  })
})

describe('engineDisplayName', () => {
  it('names every engine type the wire can carry', () => {
    expect(engineDisplayName('Vllm')).toBe('vLLM')
    expect(engineDisplayName('LlamaCpp')).toBe('llama.cpp')
  })
})

describe('engineIconSrc', () => {
  it('maps every engine type to a shipped icon', () => {
    expect(engineIconSrc('Vllm')).toBe('/icons/vllm.svg')
    expect(engineIconSrc('LlamaCpp')).toBe('/icons/llama-cpp.svg')
  })
})

describe('shortGpuName', () => {
  it('strips the vendor prefix for compact column labels', () => {
    expect(shortGpuName('NVIDIA GeForce RTX 3090')).toBe('RTX 3090')
    expect(shortGpuName('NVIDIA RTX PRO 6000 Blackwell Workstation Edition')).toBe(
      'RTX PRO 6000 Blackwell Workstation Edition',
    )
  })

  it('leaves an already-short name untouched', () => {
    expect(shortGpuName('RTX 3090')).toBe('RTX 3090')
  })
})
