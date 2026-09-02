import { engineDescription } from '@/lib/format'
import { getProviderLogo, type ProviderLogo } from '@/lib/providerLogo'
import type { ResolvedEngineTarget } from './useEnginePanel'

/**
 * The engine a panel resolved to, named — or null on a host running a single
 * engine, where the panel title alone is unambiguous.
 *
 * On a host running several, every engine panel says whose numbers it is
 * showing. Two panels pinned to two engines otherwise differ only by their
 * position on the page, and a panel that has followed the page selection
 * somewhere else would look identical to one that has not.
 */
export function engineLabel(resolution: ResolvedEngineTarget): string | null {
  return resolution.multiEngine ? engineDescription(resolution.engine) : null
}

/**
 * The logo of whoever published the model this engine is serving, for the same
 * row and on the same terms as the label.
 *
 * The two say different halves of the same thing: the label names the engine
 * process, the mark names what it is serving — which is how an operator
 * actually tells two panels apart when both endpoints are localhost. Null for
 * a model no provider is recognized from, and on a single-engine host, where
 * there is nothing to tell apart.
 */
export function engineLogo(resolution: ResolvedEngineTarget): ProviderLogo | null {
  return resolution.multiEngine ? getProviderLogo(resolution.engine.model?.name) : null
}
