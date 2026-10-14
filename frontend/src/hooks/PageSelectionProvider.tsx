import { useCallback, useMemo, useState, type ReactNode } from 'react'
import type { PageSource } from '@/lib/dashboard/pageSource'
import {
  withSelectedEngine,
  withSelectedGpu,
  type PageEngineTarget,
  type SelectedTargets,
} from '@/lib/dashboard/selection'
import { PageSelectionContext, type PageSelectionValue } from './usePageSelection'

/**
 * Owns one page's selection.
 *
 * The **chosen** targets are session state, deliberately not part of the saved
 * document: which GPU an operator is looking at right now is not an arrangement
 * they authored, and writing it would make every glance at a second GPU a
 * change to what everyone else sees. Engine rotation steps the engine half of
 * it for the same reason — a kiosk cycling must not set everyone cycling. It
 * resets per page because the provider sits in the page editor, which is keyed
 * by page id.
 *
 * The **source** is the opposite — the page's persisted default, read from the
 * document and merely carried through here so the panel hooks resolve both
 * layers in one place.
 */
export function PageSelectionProvider({
  source,
  children,
}: {
  source?: PageSource
  children: ReactNode
}) {
  const [chosen, setChosen] = useState<SelectedTargets>({})

  // Stable for the life of the page, so something that selects on a timer can
  // depend on them without restarting its clock every time it selects.
  const selectGpu = useCallback(
    (index: number | null) => setChosen((current) => withSelectedGpu(current, index)),
    [],
  )
  const selectEngine = useCallback(
    (target: PageEngineTarget | null) =>
      setChosen((current) => withSelectedEngine(current, target)),
    [],
  )

  const value = useMemo(
    (): PageSelectionValue => ({
      chosen,
      ...(source === undefined ? {} : { source }),
      selectGpu,
      selectEngine,
    }),
    [chosen, source, selectGpu, selectEngine],
  )

  return <PageSelectionContext.Provider value={value}>{children}</PageSelectionContext.Provider>
}
