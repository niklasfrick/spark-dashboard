import { useExportStatus } from '@/hooks/useExportStatus'
import { lastErrorCopy, statusLight, statusLineCopy } from '@/lib/export'

const LIGHT_CLASS = {
  green: 'bg-green-500',
  red: 'bg-red-500',
  gray: 'bg-zinc-600',
} as const

/**
 * The Splunk export status indicator in the app header, next to the vLLM
 * connection badge. Polls at 10 s for as long as the app is open (ADR 0001):
 * green reachable, red down, gray not configured. Styled to match
 * `ConnectionBadge` so the two header indicators read as a pair.
 */
export function HecStatusDot() {
  const status = useExportStatus(10_000, true)
  const light = statusLight(status)
  const error = lastErrorCopy(status?.last_error ?? null)
  const tooltip = error ? `${statusLineCopy(status)} — ${error}` : statusLineCopy(status)

  return (
    <div
      title={tooltip}
      className="flex items-center gap-2 border border-white/[0.06] rounded-md px-2.5 py-1"
    >
      <span
        aria-label={tooltip}
        className={`inline-block h-2 w-2 rounded-full ${LIGHT_CLASS[light]}`}
      />
      <span className="text-sm text-zinc-400 font-normal">HEC Connection</span>
    </div>
  )
}
