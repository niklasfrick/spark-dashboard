/**
 * What a panel points at, and what it resolves to on this particular host.
 *
 * A binding is either a concrete target — a GPU by integer index, an engine by
 * endpoint, the same identity keys the rest of the dashboard uses — or the
 * sentinel `follow`, which defers to the page-level selection. Follow is what
 * lets the shipped default preset be one static document that is right on a
 * one-GPU laptop and on a four-GPU server, instead of a layout generated at
 * runtime that would need testing across every permutation.
 *
 * **Silent substitution is prohibited.** Every way of not having a target
 * resolves to something the UI renders as a placeholder keeping its grid slot —
 * never to a different target. Quietly showing one engine's numbers under the
 * label the operator pinned is the worst available failure on a metrics tool,
 * because it cannot be noticed. That is also why a pin that cannot be read does
 * not quietly revert to following: the operator may well have retitled the panel
 * after the target it named.
 */

import { findEngineByEndpoint, findGpuByIndex, type GpuIdentity } from '@/lib/identity'
import type { EngineSnapshot } from '@/types/metrics'
import { isRecord } from './json'

/**
 * Where a panel gets its target.
 *
 * Deeply readonly: bindings are values, replaced rather than edited. Without it
 * the shared `FOLLOW` and `UNREADABLE` constants would be aliased by every
 * panel that has one, and editing a single panel would reach all of them.
 */
export type PanelBinding =
  /** Whatever the page-level selector currently points at. */
  | { readonly kind: 'follow' }
  /** One GPU, pinned by its integer index. */
  | { readonly kind: 'gpu'; readonly index: number }
  /** One inference engine, pinned by its endpoint. */
  | { readonly kind: 'engine'; readonly endpoint: string }
  /**
   * Something was pinned here and it could not be read — a hand-edited file, a
   * truncated write. Kept as a state of its own rather than folded into
   * `follow`, so the panel says it needs repointing instead of showing the page
   * selection under a title that may name the target it lost.
   */
  | { readonly kind: 'unreadable' }

/** The follow sentinel. Every panel in the default preset carries this. */
export const FOLLOW: PanelBinding = { kind: 'follow' }

/** A binding that was present and could not be read. */
export const UNREADABLE: PanelBinding = { kind: 'unreadable' }

/** What a binding turned into on this host. */
export type BindingResolution<T> =
  /** The target exists; render it. */
  | { status: 'resolved'; target: T }
  /**
   * A target was asked for and is not here — a pin to a GPU index the host no
   * longer exposes, an engine whose port changed. `requested` names it so the
   * placeholder can say which panel to repoint.
   */
  | { status: 'missing'; requested: string }
  /**
   * Nothing is selected to follow, because there is nothing to select: a host
   * running no inference engines. Distinct from `missing` because it is not a
   * misconfiguration and reads differently to an operator.
   */
  | { status: 'unselected' }
  /**
   * The binding itself could not be understood — unreadable as stored, or naming
   * a kind of target this panel does not take. There is nothing to name in the
   * placeholder beyond "repoint this panel".
   */
  | { status: 'unreadable' }

/**
 * Reads a persisted binding.
 *
 * An **absent** binding becomes `follow`: nothing was ever pinned, so following
 * the page is the default rather than a substitution. A binding that is
 * **present but malformed** becomes `unreadable` — it did name a target, and
 * guessing which would risk showing the wrong numbers under the operator's own
 * label.
 */
export function readBinding(raw: unknown): PanelBinding {
  if (raw === undefined || raw === null) return FOLLOW
  if (!isRecord(raw)) return UNREADABLE

  switch (raw.kind) {
    case 'follow':
      return FOLLOW
    case 'gpu':
      return isGpuIndex(raw.index) ? { kind: 'gpu', index: raw.index } : UNREADABLE
    case 'engine':
      return typeof raw.endpoint === 'string' && raw.endpoint.length > 0
        ? { kind: 'engine', endpoint: raw.endpoint }
        : UNREADABLE
    default:
      return UNREADABLE
  }
}

/**
 * Resolves a GPU panel's binding against the GPUs on this host.
 *
 * `pageGpuIndex` is the page-level selection a following panel defers to, null
 * when there is nothing selected. A selection that is not on the host is
 * reported as missing rather than nudged to the primary GPU — the page label and
 * the panel's data have to agree.
 */
export function resolveGpuBinding<T extends GpuIdentity>(
  binding: PanelBinding,
  gpus: readonly T[],
  pageGpuIndex: number | null,
): BindingResolution<T> {
  // Including a binding that names an engine: on a GPU panel that is a corrupt
  // document, and picking some GPU to show anyway is the prohibited failure.
  if (binding.kind !== 'follow' && binding.kind !== 'gpu') return { status: 'unreadable' }

  const index = binding.kind === 'gpu' ? binding.index : pageGpuIndex

  // Only a following panel can have nothing to follow. A pin names a GPU, so an
  // empty host makes it missing rather than unselected — the operator asked for
  // something specific and it is not here.
  if (index === null || (binding.kind === 'follow' && gpus.length === 0)) {
    return { status: 'unselected' }
  }

  const target = findGpuByIndex(gpus, index)
  return target ? { status: 'resolved', target } : { status: 'missing', requested: `GPU ${index}` }
}

/**
 * Resolves an engine panel's binding against the engines detected on this host.
 *
 * `pageEngineEndpoint` is the page-level selection. A host with no engines, or a
 * page with no engine selected, is `unselected` — hardware monitoring is still
 * useful there, so it is a graceful state rather than a failure.
 */
export function resolveEngineBinding<T extends Pick<EngineSnapshot, 'endpoint'>>(
  binding: PanelBinding,
  engines: readonly T[],
  pageEngineEndpoint: string | null | undefined,
): BindingResolution<T> {
  if (binding.kind !== 'follow' && binding.kind !== 'engine') return { status: 'unreadable' }

  const endpoint = binding.kind === 'engine' ? binding.endpoint : pageEngineEndpoint
  if (!endpoint) return { status: 'unselected' }

  const target = findEngineByEndpoint(engines, endpoint)
  return target ? { status: 'resolved', target } : { status: 'missing', requested: endpoint }
}

/** A GPU index as the backend reports them: a non-negative whole number. */
function isGpuIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
