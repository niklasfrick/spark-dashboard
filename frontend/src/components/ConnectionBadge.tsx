import type { ConnectionStatus } from '../hooks/useMetrics'

const statusConfig = {
  connected:    { dotClass: 'bg-green-500',  label: 'Connected',       pulse: false },
  reconnecting: { dotClass: 'bg-yellow-500', label: 'Reconnecting...', pulse: true },
  disconnected: { dotClass: 'bg-red-500',    label: 'Disconnected',    pulse: false },
} as const

export function ConnectionBadge({ status, isStale }: { status: ConnectionStatus; isStale: boolean }) {
  const config = statusConfig[status]
  return (
    <div className="flex items-center gap-2 border border-white/[0.06] rounded-md px-2.5 py-1">
      <span className={`inline-block w-2 h-2 rounded-full ${config.dotClass} ${config.pulse ? 'animate-pulse-dot' : ''}`} />
      <span className="text-sm text-zinc-400 font-normal">{config.label}</span>
      {isStale && status === 'connected' && (
        <span className="text-sm text-zinc-600">(stale)</span>
      )}
    </div>
  )
}
