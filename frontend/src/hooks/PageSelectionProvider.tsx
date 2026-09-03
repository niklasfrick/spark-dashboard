import { useMemo, useState, type ReactNode } from 'react'
import { withSelectedEngine, withSelectedGpu, type SelectedTargets } from '@/lib/dashboard/selection'
import { PageSelectionContext, type PageSelectionValue } from './usePageSelection'

/**
 * Owns one page's selection.
 *
 * Session state, deliberately not part of the saved document: which GPU an
 * operator is looking at right now is not an arrangement they authored, and
 * writing it would make every glance at a second GPU a change to what everyone
 * else sees. It resets per page because the provider sits inside the page, which
 * is keyed by page id.
 */
export function PageSelectionProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState<SelectedTargets>({})

  const value = useMemo(
    (): PageSelectionValue => ({
      chosen,
      selectGpu: (index) => setChosen((current) => withSelectedGpu(current, index)),
      selectEngine: (endpoint) => setChosen((current) => withSelectedEngine(current, endpoint)),
    }),
    [chosen],
  )

  return <PageSelectionContext.Provider value={value}>{children}</PageSelectionContext.Provider>
}
