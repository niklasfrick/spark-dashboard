import type { ReactNode } from 'react'
import { ConnectionBadge } from './ConnectionBadge'
import type { ConnectionStatus } from '@/hooks/useMetrics'

/**
 * The product masthead: title, page navigation, and connection badge.
 *
 * The page tabs sit *between* the title and the badge rather than replacing
 * either: the header's existing identity is what tells an operator at a glance
 * which tool they are looking at, and the rework preserves it. `pages` is a slot
 * rather than a prop the header renders itself, so the masthead stays free of
 * the configuration — it draws the same on the frame that has no document yet.
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
        {/* The green mark is the identity and always shows; the second word is
            the first thing to go when the header is narrow, because a masthead
            that leaves no room for the page tabs has crowded out the navigation
            it exists to sit beside. */}
        <span className="hidden sm:inline text-zinc-500 font-normal">Dashboard</span>
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
