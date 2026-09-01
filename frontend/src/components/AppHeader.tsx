import { ConnectionBadge } from './ConnectionBadge'
import type { ConnectionStatus } from '@/hooks/useMetrics'

/**
 * The product masthead: title and connection badge. Shared by the root
 * dashboard and the grid pages so both routes read as the same product; the
 * page tabs (#85) will slot in here between the two.
 */
export function AppHeader({ status, isStale }: { status: ConnectionStatus; isStale: boolean }) {
  return (
    <header className="shrink-0 border-b border-white/[0.04] px-4 py-1.5 flex justify-between items-center">
      <h1
        className="text-xl font-semibold text-zinc-100 tracking-tight"
        style={{ fontFamily: 'Inter, sans-serif' }}
      >
        <span className="text-[#76B900]">Spark</span>{' '}
        <span className="text-zinc-500 font-normal">Dashboard</span>
      </h1>
      <ConnectionBadge status={status} isStale={isStale} />
    </header>
  )
}
