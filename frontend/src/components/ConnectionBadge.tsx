import type { ConnectionStatus } from '../hooks/useMetrics'

const statusConfig = {
  connected:    { dotClass: 'bg-green-500',  title: 'Connected',       pulse: false },
  reconnecting: { dotClass: 'bg-yellow-500', title: 'Reconnecting...', pulse: true },
  disconnected: { dotClass: 'bg-red-500',    title: 'Disconnected',    pulse: false },
} as const

/**
 * The engine/vLLM metrics WebSocket status in the app header, next to the
 * HEC export dot. The label names the connector so the two header
 * indicators read the same way (ADR 0001's "HEC Connection" / "vLLM
 * Connection" pairing); the dot still carries the live state.
 */
export function ConnectionBadge({ status, isStale }: { status: ConnectionStatus; isStale: boolean }) {
  const config = statusConfig[status]
  return (
    <div
      title={config.title}
      className="flex items-center gap-2 border border-white/[0.06] rounded-md px-2.5 py-1"
    >
      <span
        aria-label={config.title}
        className={`inline-block w-2 h-2 rounded-full ${config.dotClass} ${config.pulse ? 'animate-pulse-dot' : ''}`}
      />
      <span className="text-sm text-zinc-400 font-normal">vLLM Connection</span>
      {isStale && status === 'connected' && (
        <span className="text-sm text-zinc-600">(stale)</span>
      )}
    </div>
  )
}
