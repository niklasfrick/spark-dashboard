import { engineDescription, modelMetadataWarning, shortModelName } from '@/lib/format'
import { getProviderLogo, type ProviderLogo } from '@/lib/providerLogo'
import type { AggregateEngineTarget, ResolvedEngineTarget } from './useEnginePanel'

/**
 * The engine a panel resolved to, named — or null on a host running a single
 * engine, where the panel title alone is unambiguous.
 *
 * On a host running several, every engine panel says whose numbers it is
 * showing. Two panels pinned to two engines otherwise differ only by their
 * position on the page, and a panel that has followed the page selection
 * somewhere else would look identical to one that has not.
 *
 * A panel following a page configured to show all models is named on the same
 * terms: "All models" is what its numbers are, and a combined figure wearing no
 * name would read as one engine's.
 */
export function engineLabel(
  resolution: ResolvedEngineTarget | AggregateEngineTarget,
): string | null {
  if (resolution.status === 'aggregate') return 'All models'
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
  /** Why `model` may be wrong: the engine refused to say what it serves, so
   *  the name (if any) is only the launch command line's word for it. Null
   *  when there is nothing to warn about. */
  modelWarning: string | null
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
 *
 * The aggregate wears an identity **unconditionally**, single-engine hosts
 * included: a combined figure is a different thing from an engine's own, and
 * the row is the only place the panel says so.
 */
export function engineIdentity(
  resolution: ResolvedEngineTarget | AggregateEngineTarget,
): EngineIdentity {
  if (resolution.status === 'aggregate') {
    return {
      label: `${resolution.running} of ${resolution.total} serving`,
      model: 'All models',
      logo: null,
      modelWarning: null,
    }
  }

  if (!resolution.multiEngine) {
    return { label: null, model: null, logo: null, modelWarning: null }
  }

  const { model } = resolution.engine
  return {
    label: engineDescription(resolution.engine),
    model: model?.name ? shortModelName(model.name) : null,
    logo: getProviderLogo(model?.name),
    modelWarning: modelMetadataWarning(resolution.engine.model_metadata_error),
  }
}
