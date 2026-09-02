import type { ReactNode } from 'react'
import { ConnectionBadge } from './ConnectionBadge'
import type { ConnectionStatus } from '@/hooks/useMetrics'

/**
 * The product masthead: title, page navigation, and connection badge. Shared by
 * the root dashboard and the grid pages so both routes read as the same product.
 *
 * The page tabs sit *between* the title and the badge rather than replacing
 * either: the header's existing identity is what tells an operator at a glance
 * which tool they are looking at, and the rework preserves it. `pages` is a slot
 * because only the grid routes have pages to show — the root URL keeps serving
 * the pre-grid dashboard untouched until the #86 cutover.
 */
export function AppHeader({
  status,
  isStale,
  pages,
}: {
  status: ConnectionStatus
  isStale: boolean
  pages?: ReactNode
}) {
  return (
    <header className="shrink-0 border-b border-white/[0.04] px-4 py-1.5 flex items-center gap-3">
      <h1
        className="shrink-0 text-xl font-semibold text-zinc-100 tracking-tight"
        style={{ fontFamily: 'Inter, sans-serif' }}
      >
        <span className="text-[#76B900]">Spark</span>{' '}
        <span className="text-zinc-500 font-normal">Dashboard</span>
      </h1>

      {pages}

      {/* `ml-auto` rather than `justify-between`, so the badge stays hard right
          whether or not there are pages between it and the title. */}
      <div className="ml-auto shrink-0">
        <ConnectionBadge status={status} isStale={isStale} />
      </div>
    </header>
  )
}
