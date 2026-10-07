/**
 * Reading one engine's metrics, and deciding whether there are any to read.
 *
 * Both rules are shared rather than re-derived per card or panel, because both
 * are easy to get subtly wrong in ways that show stale numbers: an engine whose
 * model was unloaded still ships its last metrics, and an engine that has just
 * started ships none at all while being perfectly healthy.
 */

import type { EngineMetrics, EngineSnapshot } from '@/types/metrics'

/** The parts of an engine snapshot that decide what its metrics mean. */
export type EngineReadable = Pick<
  EngineSnapshot,
  'status' | 'model' | 'metrics' | 'metrics_disabled'
>

/**
 * The metric fields that carry a plain number — everything a tile can render
 * directly, as opposed to the percentile structs and histogram buckets that a
 * panel has to derive something from first.
 */
export type NumericEngineMetric = {
  [K in keyof EngineMetrics]-?: EngineMetrics[K] extends number | null ? K : never
}[keyof EngineMetrics]

/** Reads one field of an engine's metrics; null when there is no value to read. */
export type EngineMetricReader = <K extends keyof EngineMetrics>(
  key: K,
) => EngineMetrics[K] | null

/**
 * A reader over one engine's metrics.
 *
 * An engine with **no model loaded** reads as having no values at all. Its last
 * metrics describe a model that is no longer being served, and showing them
 * would put numbers from a finished run under the name of an idle engine.
 */
export function engineMetricReader(engine: EngineReadable): EngineMetricReader {
  const metrics = engine.model === null ? null : engine.metrics
  return (key) => metrics?.[key] ?? null
}

/** Whether an engine has metrics worth rendering, and why not when it has not. */
export type EngineAvailability =
  /** Serving, with metrics. */
  | { kind: 'ready' }
  /** Up, but no metrics have arrived yet — starting, or loading a model. */
  | { kind: 'starting' }
  /** Up and serving, but the `/metrics` endpoint is off (e.g. llama.cpp started
   *  without `--metrics`). The operator can act on it. */
  | { kind: 'metrics-disabled' }
  /** Nothing to show, for a reason the operator can act on. `detail` completes
   *  the sentence "<engine> …". */
  | { kind: 'offline'; detail: string }

/**
 * What an engine can currently show.
 *
 * The distinction that matters is between an engine that is *fine and not ready
 * yet* and one that is *not running*: the first resolves itself in a second, the
 * second needs the operator to do something. A grid of dashes says neither.
 */
export function engineAvailability(engine: EngineReadable): EngineAvailability {
  switch (engine.status.type) {
    case 'Stopped':
      return { kind: 'offline', detail: 'is not running.' }
    case 'Error':
      return { kind: 'offline', detail: `reported an error: ${engine.status.message}` }
  }

  if (engine.model === null) return { kind: 'offline', detail: 'has no model loaded.' }
  if (engine.metrics === null) {
    // Same "no metrics" reading, but the cause is different and actionable: the
    // server is up and serving, it simply has no metrics endpoint enabled.
    return engine.metrics_disabled ? { kind: 'metrics-disabled' } : { kind: 'starting' }
  }
  return { kind: 'ready' }
}
