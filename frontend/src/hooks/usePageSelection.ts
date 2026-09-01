import { createContext, useContext } from 'react'
import type { SelectedTargets } from '@/lib/dashboard/selection'

/**
 * What one page is pointed at, and how to point it somewhere else.
 *
 * Only the operator's explicit choice travels through the context; resolving it
 * against the host is `pageSelection()`, which the panel hooks call because they
 * already hold the snapshot. Keeping the context to the choice alone means a
 * page that has never been pointed anywhere costs nothing and re-renders for
 * nothing.
 */
export interface PageSelectionValue {
  /** What the operator pointed this page at. Empty = follow the host. */
  chosen: SelectedTargets
  /** Point every following panel at one GPU; null goes back to the host default. */
  selectGpu: (index: number | null) => void
  /** Point every following panel at one engine; null goes back to the host default. */
  selectEngine: (endpoint: string | null) => void
}

/**
 * Following the host, with no way to change it. This is what a panel rendered
 * outside a page gets — a spec, a future preview — so a panel never has to know
 * whether it is on a page.
 */
const FOLLOW_THE_HOST: PageSelectionValue = {
  chosen: {},
  selectGpu: () => {},
  selectEngine: () => {},
}

/** Exported for `PageSelectionProvider`, which cannot live in this file without
 *  breaking fast refresh. Read the selection through `usePageSelection`. */
export const PageSelectionContext = createContext<PageSelectionValue>(FOLLOW_THE_HOST)

export function usePageSelection(): PageSelectionValue {
  return useContext(PageSelectionContext)
}
