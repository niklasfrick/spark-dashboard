import { engineDescription } from '@/lib/format'
import { getProviderLogo, type ProviderLogo } from '@/lib/providerLogo'
import type { ResolvedEngineTarget } from './useEnginePanel'

/**
 * Strip the `Organization/` prefix off a HuggingFace-style id, leaving the
 * model itself: `Qwen/Qwen3-8B` reads as `Qwen3-8B`. The organization is
 * already said by the provider mark beside it, so repeating it in the name
 * spends the width a long model id needs.
 */
export function shortModelName(name: string): string {
  return name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
}

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
  /** The engine process, named by provider and endpoint. Null on a
   *  single-engine host. */
  label: string | null
  /** The model it is serving, without its organization prefix. Null on a
   *  single-engine host, and where the engine has reported no model. */
  model: string | null
  /** The provider of that model. Null on a single-engine host, and for a model
   *  no shipped provider is recognized from. */
  logo: ProviderLogo | null
}

/**
 * Every part of the identity a panel wears, resolved together because they are
 * only ever shown together.
 *
 * All three say different things. The model is what an operator thinks in and
 * reads first; the endpoint is what actually identifies the engine, because two
 * of them can legitimately serve the same model; the mark is the provider, at a
 * glance. All are absent on a single-engine host, where there is nothing to
 * tell apart and the row would only cost the panel height.
 */
export function engineIdentity(resolution: ResolvedEngineTarget): EngineIdentity {
  if (!resolution.multiEngine) return { label: null, model: null, logo: null }

  const { model } = resolution.engine
  return {
    label: engineDescription(resolution.engine),
    model: model?.name ? shortModelName(model.name) : null,
    logo: getProviderLogo(model?.name),
  }
}
