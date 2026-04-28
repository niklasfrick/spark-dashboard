import { describe, it, expect } from 'vitest'
import { formatBytes, formatGiB } from '../lib/format'

const GIB = 1_073_741_824
const MIB = 1_048_576

describe('formatGiB', () => {
  it('renders 128 GiB as "128 GB" (matches DGX Spark unified pool)', () => {
    expect(formatGiB(128 * GIB)).toBe('128 GB')
  })

  it('rounds to integer by default', () => {
    expect(formatGiB(127.6 * GIB)).toBe('128 GB')
  })

  it('respects the decimals argument', () => {
    expect(formatGiB(2.5 * GIB, 1)).toBe('2.5 GB')
  })
})

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
