import { describe, it, expect } from 'vitest'
import {
  formatBytes,
  formatCompactTokens,
  formatAcceptanceLength,
  formatEndpoint,
  engineDescription,
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

describe('engineDescription', () => {
  it('names the provider and the instance', () => {
    // Both halves are needed: a host can run several engines of one provider,
    // which is exactly when a panel has to say which one it shows.
    expect(engineDescription({ engine_type: 'Vllm', endpoint: 'http://localhost:8001' })).toBe(
      'vLLM localhost:8001',
    )
  })
})
