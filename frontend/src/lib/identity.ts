import type { EngineSnapshot, GpuMetrics, MetricsSnapshot } from '@/types/metrics'

/**
 * Identity helpers for the two things the dashboard binds to: an inference
 * engine and a GPU.
 *
 * Both identities were previously re-derived by hand at every use site, which
 * made it impossible to tell whether two places meant the same entity. They
 * live here so panels can pin to a target — a GPU by integer index, an engine
 * by endpoint — against one definition.
 */

/** The fields of an engine snapshot that make up its identity. */
export type EngineIdentity = Pick<EngineSnapshot, 'engine_type' | 'endpoint'>

/** The field of a GPU snapshot that makes up its identity. */
export type GpuIdentity = Pick<GpuMetrics, 'index'>

/**
 * Composite identity of one engine. A host can run several engines of the
 * same type, so neither half is unique on its own.
 *
 * This is the key for the per-engine history buffers, the value of the engine
 * tab, the tab id persisted to localStorage and the scope of the per-model SLO
 * settings — every one of those must agree, so they all come through here.
 *
 * Not the same string as the endpoint the log socket and panel bindings use:
 * those name the engine to the *backend*, which knows engines by endpoint
 * alone. Use `findEngineByEndpoint` for that direction.
 */
export function engineKey(engine: EngineIdentity): string {
  return `${engine.engine_type}-${engine.endpoint}`
}

/**
 * Resolve an engine key back to its snapshot. Returns undefined when the key
 * names an engine that is not in the list — restored from localStorage before
 * any metrics arrived, or stopped since it was selected. Callers decide what
 * to fall back to; substituting a different engine here would silently show
 * one engine's numbers under another's label.
 */
export function findEngineByKey<T extends EngineIdentity>(
  engines: readonly T[],
  key: string | null | undefined,
): T | undefined {
  if (!key) return undefined
  return engines.find((engine) => engineKey(engine) === key)
}

/**
 * Resolve an endpoint to its engine snapshot — the direction panel bindings
 * and the log socket use, since the backend addresses engines by endpoint.
 * Undefined when the bound engine is absent, same contract as
 * `findEngineByKey`.
 */
export function findEngineByEndpoint<T extends Pick<EngineSnapshot, 'endpoint'>>(
  engines: readonly T[],
  endpoint: string | null | undefined,
): T | undefined {
  if (!endpoint) return undefined
  return engines.find((engine) => engine.endpoint === endpoint)
}

/**
 * A GPU's index, normalized. The field is optional (older backends omit it)
 * and nullable (the collector reports null when NVML has no index for the
 * device); both cases mean the primary GPU.
 */
export function gpuIndexOf(gpu: GpuIdentity): number {
  return gpu.index ?? 0
}

/**
 * The GPUs on a snapshot. Backends that predate multi-GPU support ship only
 * the single `gpu` field, so an absent or empty `gpus` list falls back to it —
 * the result always holds at least one GPU.
 */
export function snapshotGpus(
  snapshot: Pick<MetricsSnapshot, 'gpu' | 'gpus'>,
): GpuMetrics[] {
  return snapshot.gpus && snapshot.gpus.length > 0 ? snapshot.gpus : [snapshot.gpu]
}

/**
 * Resolve a GPU index to its snapshot, matching on the normalized index so a
 * legacy GPU with no index answers to 0. Undefined when the index is not on
 * the host; callers decide what to fall back to.
 */
export function findGpuByIndex<T extends GpuIdentity>(
  gpus: readonly T[],
  index: number,
): T | undefined {
  return gpus.find((gpu) => gpuIndexOf(gpu) === index)
}
