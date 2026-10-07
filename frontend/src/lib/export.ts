/**
 * Talking to the server about the Splunk HEC exporter — the control plane of
 * the `export.hec` document section.
 *
 * The document itself (url/token/index) is written and read by the dashboard
 * configuration client; this module is what the exporter *is doing* right now
 * and the connectivity test the settings dialog fires. The server answers
 * with short machine-readable codes and owns no operator copy — this module
 * is where those codes become the lines the operator reads.
 */

/** What the exporter is doing right now, as `GET /api/export-status` reports it. */
export interface ExportStatus {
  state: 'disabled' | 'idle' | 'exporting' | 'down'
  /** The last HEC contact (ingest or probe) got an HTTP response. */
  reachable: boolean
  last_ok_ms: number | null
  /** A short machine-readable code (`"hec-403"`, `"connection-failed"`, …). */
  last_error: string | null
  /** Snapshots dropped by the idle gate, the down state, or backlog overflow. */
  dropped_count: number
}

/** What the Test-connection probe found. */
export type TestOutcome =
  | 'ok'
  | 'invalid-token'
  | 'index-denied'
  | 'queue-full'
  | 'misconfigured'
  | 'server-error'
  | 'unreachable'

export interface TestResult {
  outcome: TestOutcome
  /** The index the test event was written to, when the test ran. */
  index: string | null
}

const STATUS_URL = '/api/export-status'
const TEST_URL = '/api/export/test'

/** Reads the exporter status. Never throws; `null` means "not reporting". */
export async function fetchExportStatus(): Promise<ExportStatus | null> {
  try {
    const response = await fetch(STATUS_URL)
    if (!response.ok) return null
    return (await response.json()) as ExportStatus
  } catch {
    return null
  }
}

/** An in-progress edit in the settings dialog, not yet saved. */
export interface TestOverride {
  url?: string
  token?: string
  index?: string
}

/**
 * Fires the connectivity test event against `override_` — the dialog's
 * current field values — so testing an edit never requires saving it first.
 * A field left out falls back to the stored target on the server (same rule
 * as a save: an empty or masked token keeps the stored one). Never throws.
 */
export async function testExportConnection(override_: TestOverride = {}): Promise<TestResult> {
  try {
    const response = await fetch(TEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(override_),
    })
    if (!response.ok) return { outcome: 'misconfigured', index: null }
    return (await response.json()) as TestResult
  } catch {
    return { outcome: 'unreachable', index: null }
  }
}

/** What the Test-connection button says for each outcome (ADR 0001). */
export function testOutcomeCopy(
  outcome: TestOutcome,
  details: { url?: string; index?: string | null } = {},
): string {
  switch (outcome) {
    case 'ok':
      return `OK — test event written to ${details.index ?? 'the metrics index'}`
    case 'invalid-token':
      return 'HEC token invalid or disabled'
    case 'index-denied':
      return 'Index not allowed by this token — check the token’s indexes list'
    case 'queue-full':
      return 'HEC queue full, try again'
    case 'server-error':
      return 'HEC server error, try again'
    case 'unreachable':
      return `Cannot reach ${details.url ?? 'the HEC endpoint'}`
    case 'misconfigured':
      return 'Configure a URL and token first'
  }
}

/** What a status-line `last_error` code means to the operator. `null` says nothing. */
export function lastErrorCopy(code: string | null, url?: string): string | null {
  switch (code) {
    case 'hec-403':
      return 'HEC token invalid or disabled'
    case 'hec-400-index-denied':
      return 'Index not allowed by this token — check the token’s indexes list'
    case 'hec-429-or-5xx':
      return 'HEC is rate-limiting or erroring — retrying'
    case 'connection-failed':
      return `Cannot reach ${url ?? 'the HEC endpoint'}`
    case null:
      return null
    default:
      return 'HEC rejected the events'
  }
}

/** The status light, per ADR 0001: green reachable, red down, gray unconfigured. */
export type LightState = 'green' | 'red' | 'gray'

export function statusLight(status: ExportStatus | null): LightState {
  if (status === null || status.state === 'disabled') return 'gray'
  return status.reachable ? 'green' : 'red'
}

/** The one-line state the settings dialog shows under the light. */
export function statusLineCopy(status: ExportStatus | null): string {
  switch (status?.state) {
    case 'disabled':
      return 'Export not configured'
    case 'idle':
      return 'Host idle — nothing to export'
    case 'exporting':
      return 'Exporting'
    case 'down':
      return 'Endpoint unreachable — probing every 60 s'
    default:
      return 'Exporter not reporting'
  }
}
