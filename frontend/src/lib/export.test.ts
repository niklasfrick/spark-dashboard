import { describe, it, expect } from 'vitest'
import {
  lastErrorCopy,
  statusLight,
  statusLineCopy,
  testOutcomeCopy,
  type ExportStatus,
} from './export'

function status(overrides: Partial<ExportStatus> = {}): ExportStatus {
  return {
    state: 'exporting',
    reachable: true,
    last_ok_ms: 1_723_800_000_000,
    last_error: null,
    dropped_count: 0,
    ...overrides,
  }
}

describe('testOutcomeCopy', () => {
  it('maps every outcome to its ADR 0001 copy', () => {
    expect(testOutcomeCopy('ok', { index: 'metrics' })).toBe('OK — test event written to metrics')
    expect(testOutcomeCopy('invalid-token')).toBe('HEC token invalid or disabled')
    expect(testOutcomeCopy('index-denied')).toBe(
      'Index not allowed by this token — check the token’s indexes list',
    )
    expect(testOutcomeCopy('queue-full')).toBe('HEC queue full, try again')
    expect(testOutcomeCopy('server-error')).toBe('HEC server error, try again')
    expect(testOutcomeCopy('unreachable', { url: 'https://splunk.example.com' })).toBe(
      'Cannot reach https://splunk.example.com',
    )
    expect(testOutcomeCopy('misconfigured')).toBe('Configure a URL and token first')
  })
})

describe('lastErrorCopy', () => {
  it('maps the machine codes to operator copy', () => {
    expect(lastErrorCopy(null)).toBeNull()
    expect(lastErrorCopy('hec-403')).toBe('HEC token invalid or disabled')
    expect(lastErrorCopy('hec-400-index-denied')).toContain('indexes list')
    expect(lastErrorCopy('hec-429-or-5xx')).toContain('retrying')
    expect(lastErrorCopy('connection-failed', 'https://splunk.example.com')).toBe(
      'Cannot reach https://splunk.example.com',
    )
    expect(lastErrorCopy('hec-something-new')).toBe('HEC rejected the events')
  })
})

describe('statusLight', () => {
  it('is gray when not configured and the exporter is not reporting', () => {
    expect(statusLight(null)).toBe('gray')
    expect(statusLight(status({ state: 'disabled' }))).toBe('gray')
  })

  it('is green while reachable, including rejected-but-reachable states', () => {
    expect(statusLight(status({ state: 'exporting', reachable: true }))).toBe('green')
    expect(statusLight(status({ state: 'idle', reachable: true }))).toBe('green')
  })

  it('is red while down', () => {
    expect(statusLight(status({ state: 'down', reachable: false }))).toBe('red')
  })
})

describe('statusLineCopy', () => {
  it('describes each state', () => {
    expect(statusLineCopy(null)).toBe('Exporter not reporting')
    expect(statusLineCopy(status({ state: 'disabled' }))).toBe('Export not configured')
    expect(statusLineCopy(status({ state: 'idle' }))).toBe('Host idle — nothing to export')
    expect(statusLineCopy(status({ state: 'exporting' }))).toBe('Exporting')
    expect(statusLineCopy(status({ state: 'down' }))).toContain('unreachable')
  })
})
