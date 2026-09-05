/**
 * The page-level selection: the GPU and the engine target a page's `follow`
 * panels point at.
 *
 * This is the other half of the binding model in `bindings.ts`. A pinned panel
 * names its own target; every other panel defers to the selection here, which is
 * what lets the shipped default preset be one static document that is right on a
 * one-GPU laptop and on a four-GPU server. Change the selection and the whole
 * page moves with it, coherently, because every following panel reads the same
 * value.
 *
 * The selection has three layers, strongest first. What the operator **chose in
 * this session** is stored sparsely — an absent key means they have never
 * chosen, not that they chose nothing. Under that sits the page's **configured
 * source** (`pageSource.ts`), which is the choice written into the document:
 * one engine, or every engine combined. The host's own defaults fill what
 * remains. Keeping the layers apart matters on a machine whose engines come and
 * go: an unconfigured page follows whatever is running, while a page configured
 * for engine B keeps pointing at B, and the panels say B is missing rather than
 * quietly showing engine A.
 */

import { gpuIndexOf, snapshotGpus } from '@/lib/identity'
import type { EngineSnapshot, MetricsSnapshot } from '@/types/metrics'
import type { PageSource } from './pageSource'

/**
 * What a page's following engine panels resolve to: one engine by endpoint, or
 * the aggregate over all of them.
 */
export type PageEngineTarget =
  | { kind: 'engine'; endpoint: string }
  /** Every engine at once — the combined figures, not any one engine's. */
  | { kind: 'all' }

/** What a page's `follow` panels resolve against. */
export interface PageSelection {
  /** The GPU index following panels show. Null when the host reports no GPU. */
  gpuIndex: number | null
  /** The engine target following panels show. Null when no engine is running. */
  engineTarget: PageEngineTarget | null
}

/**
 * What the operator explicitly pointed the page at, for this session. A key is
 * present only once they have chosen; absent means "defer to the page's source,
 * then the host", which is where every page starts.
 */
export interface SelectedTargets {
  readonly gpuIndex?: number
  readonly engineEndpoint?: string
}

/** Nothing to point at: no snapshot, or a host with neither GPU nor engine. */
export const NO_SELECTION: PageSelection = { gpuIndex: null, engineTarget: null }

/**
 * The selection a page resolves to on this host.
 *
 * An explicit choice — the session's, or the page's configured source — is kept
 * verbatim, including one naming an engine that is no longer here: panels
 * report that as missing, which is the whole point. The operator who changed an
 * engine's port has to see which pages now point at nothing. Only an unchosen
 * target falls back to the host's default.
 */
export function pageSelection(
  snapshot: Pick<MetricsSnapshot, 'gpu' | 'gpus' | 'engines'> | null,
  chosen: SelectedTargets,
  source?: PageSource,
): PageSelection {
  return {
    gpuIndex: chosen.gpuIndex ?? (snapshot ? defaultGpuIndex(snapshot) : null),
    engineTarget: engineTarget(snapshot, chosen, source),
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

/** The three layers, strongest first: session choice, configured source, host. */
function engineTarget(
  snapshot: Pick<MetricsSnapshot, 'engines'> | null,
  chosen: SelectedTargets,
  source: PageSource | undefined,
): PageEngineTarget | null {
  if (chosen.engineEndpoint !== undefined) {
    return { kind: 'engine', endpoint: chosen.engineEndpoint }
  }
  if (source !== undefined) {
    return source.kind === 'all' ? { kind: 'all' } : { kind: 'engine', endpoint: source.endpoint }
  }
  const endpoint = snapshot ? defaultEngineEndpoint(snapshot.engines) : null
  return endpoint === null ? null : { kind: 'engine', endpoint }
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
