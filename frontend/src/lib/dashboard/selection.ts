/**
 * The page-level selection: the GPU and the engine a page's `follow` panels
 * point at.
 *
 * This is the other half of the binding model in `bindings.ts`. A pinned panel
 * names its own target; every other panel defers to the selection here, which is
 * what lets the shipped default preset be one static document that is right on a
 * one-GPU laptop and on a four-GPU server. Change the selection and the whole
 * page moves with it, coherently, because every following panel reads the same
 * value.
 *
 * The selection has two layers. What the operator **chose** is stored sparsely —
 * an absent key means they have never chosen, not that they chose nothing — and
 * the host's own defaults fill the gaps. Keeping them apart matters on a machine
 * whose engines come and go: an operator who chose nothing follows whatever is
 * running, while an operator who chose engine B keeps pointing at B, and the
 * panels say B is missing rather than quietly showing engine A.
 */

import { gpuIndexOf, snapshotGpus } from '@/lib/identity'
import type { EngineSnapshot, MetricsSnapshot } from '@/types/metrics'

/** What a page's `follow` panels resolve against. */
export interface PageSelection {
  /** The GPU index following panels show. Null when the host reports no GPU. */
  gpuIndex: number | null
  /** The endpoint following panels show. Null when no engine is running. */
  engineEndpoint: string | null
}

/**
 * What the operator explicitly pointed the page at. A key is present only once
 * they have chosen; absent means "follow the host", which is where every page
 * starts.
 */
export interface SelectedTargets {
  readonly gpuIndex?: number
  readonly engineEndpoint?: string
}

/** Nothing to point at: no snapshot, or a host with neither GPU nor engine. */
export const NO_SELECTION: PageSelection = { gpuIndex: null, engineEndpoint: null }

/**
 * The selection a page resolves to on this host.
 *
 * An explicit choice is kept verbatim, including one naming a target that is no
 * longer here — panels report that as missing, which is the whole point: the
 * operator who changed an engine's port has to see which panels now point at
 * nothing. Only an unchosen target falls back to the host's default.
 */
export function pageSelection(
  snapshot: Pick<MetricsSnapshot, 'gpu' | 'gpus' | 'engines'> | null,
  chosen: SelectedTargets,
): PageSelection {
  if (!snapshot) {
    return {
      gpuIndex: chosen.gpuIndex ?? null,
      engineEndpoint: chosen.engineEndpoint ?? null,
    }
  }

  return {
    gpuIndex: chosen.gpuIndex ?? defaultGpuIndex(snapshot),
    engineEndpoint: chosen.engineEndpoint ?? defaultEngineEndpoint(snapshot.engines),
  }
}

/** Point the page at one GPU, or back at the host's default with null. */
export function withSelectedGpu(chosen: SelectedTargets, index: number | null): SelectedTargets {
  return index === null ? without(chosen, 'gpuIndex') : { ...chosen, gpuIndex: index }
}

/** Point the page at one engine, or back at the host's default with null. */
export function withSelectedEngine(
  chosen: SelectedTargets,
  endpoint: string | null,
): SelectedTargets {
  return endpoint === null
    ? without(chosen, 'engineEndpoint')
    : { ...chosen, engineEndpoint: endpoint }
}

/**
 * Clearing a choice drops the key rather than storing a null, because absent is
 * what "never chose" looks like everywhere else — a null would freeze the page
 * on a host whose GPUs or engines change under it.
 */
function without(chosen: SelectedTargets, key: keyof SelectedTargets): SelectedTargets {
  const next: { gpuIndex?: number; engineEndpoint?: string } = { ...chosen }
  delete next[key]
  return next
}

/** The primary GPU: `snapshotGpus` always yields at least one. */
function defaultGpuIndex(snapshot: Pick<MetricsSnapshot, 'gpu' | 'gpus'>): number {
  return gpuIndexOf(snapshotGpus(snapshot)[0])
}

/**
 * The engine an unconfigured page follows: the first one actually running, and
 * only otherwise the first one detected. A host whose first-listed engine is
 * stopped still has something worth watching on the others.
 */
function defaultEngineEndpoint(engines: readonly EngineSnapshot[]): string | null {
  const running = engines.find((engine) => engine.status.type === 'Running')
  return (running ?? engines[0])?.endpoint ?? null
}
