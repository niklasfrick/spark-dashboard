import { useExportStatus } from '@/hooks/useExportStatus'
import { lastErrorCopy, statusLight, statusLineCopy } from '@/lib/export'

const LIGHT_CLASS = {
  green: 'bg-green-500',
  red: 'bg-red-500',
  gray: 'bg-zinc-600',
} as const

/**
 * The Splunk export status dot in the app header, next to the WebSocket
 * connection badge. Polls at 10 s for as long as the app is open (ADR 0001):
 * green reachable, red down, gray not configured.
 */
export function HecStatusDot() {
  const status = useExportStatus(10_000, true)
  const light = statusLight(status)
  const error = lastErrorCopy(status?.last_error ?? null)

  return (
    <span
      title={error ? `${statusLineCopy(status)} — ${error}` : statusLineCopy(status)}
      aria-label={statusLineCopy(status)}
      className={`inline-block h-2 w-2 rounded-full ${LIGHT_CLASS[light]}`}
    />
  )
}
