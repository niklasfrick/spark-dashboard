import { engineDescription } from '@/lib/format'
import type { EnginePanelResolution } from './useEnginePanel'

/**
 * The engine a panel resolved to, named — or null on a host running a single
 * engine, where the panel title alone is unambiguous.
 *
 * On a host running several, every engine panel says whose numbers it is
 * showing. Two panels pinned to two engines otherwise differ only by their
 * position on the page, and a panel that has followed the page selection
 * somewhere else would look identical to one that has not.
 */
export function engineLabel(
  resolution: Extract<EnginePanelResolution, { status: 'resolved' }>,
): string | null {
  return resolution.multiEngine ? engineDescription(resolution.engine) : null
}
