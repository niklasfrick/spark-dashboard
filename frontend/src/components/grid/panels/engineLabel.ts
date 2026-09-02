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

/** How a panel says which engine it is showing. */
export interface EngineIdentity {
  /** The engine process, named. Null on a single-engine host. */
  label: string | null
  /** The provider of the model it is serving. Null on a single-engine host,
   *  and for a model no shipped provider is recognized from. */
  logo: ProviderLogo | null
}

/**
 * Both halves of the identity a panel wears, resolved together because they are
 * only ever shown together.
 *
 * They say different things: the label names the engine process, the mark names
 * what it is serving — which is how an operator actually tells two panels apart
 * when both endpoints are on localhost. Both are absent on a single-engine
 * host, where there is nothing to tell apart.
 */
export function engineIdentity(resolution: ResolvedEngineTarget): EngineIdentity {
  return {
    label: engineLabel(resolution),
    logo: resolution.multiEngine ? getProviderLogo(resolution.engine.model?.name) : null,
  }
}
