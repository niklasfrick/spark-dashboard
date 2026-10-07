import { useMemo } from 'react'
import { useInferenceRequests, useLatestSnapshot, useMetricsStore } from '@/hooks/useMetricsStore'
import { usePageSelection } from '@/hooks/usePageSelection'
import { resolveEngineBinding } from '@/lib/dashboard/bindings'
import { pageSelection } from '@/lib/dashboard/selection'
import { aggregateEngineMetrics } from '@/lib/engineAggregate'
import { engineAvailability, engineMetricReader, type EngineMetricReader } from '@/lib/engineMetrics'
import { engineKey } from '@/lib/identity'
import {
  ALL_ENGINES_KEY,
  engineSeries,
  type DataPoint,
  type EngineSeriesName,
} from '@/lib/metricsHistoryStore'
import type { DashboardPanel } from '@/lib/dashboard/schema'
import type { EngineMetrics, EngineSnapshot, InferenceRequestData } from '@/types/metrics'

/** Which engine a panel's binding names on this host, before anything is asked
 *  about whether that engine is serving. */
export type EngineTargetResolution =
  /** No snapshot has arrived yet; there are no engines to resolve against. */
  | { status: 'waiting' }
  | {
      status: 'resolved'
      engine: EngineSnapshot
      /** True when the host runs more than one engine, and a panel therefore has
       *  to name the one it is showing. */
      multiEngine: boolean
    }
  /**
   * Every running engine at once: the page is configured for all models and
   * this panel follows it. Only reached with at least one engine serving — a
   * host running none is `unselected`, exactly as it is for a single target.
   */
  | {
      status: 'aggregate'
      running: number
      total: number
      /** Every engine on the host, in detection order — what the row view
       *  divides the panel across. */
      engines: EngineSnapshot[]
    }
  | { status: 'missing'; requested: string }
  | { status: 'unselected' }
  | { status: 'unreadable' }

/** An engine a panel resolved its binding to. */
export type ResolvedEngineTarget = Extract<EngineTargetResolution, { status: 'resolved' }>

/** The all-engines aggregate a panel resolved its binding to. */
export type AggregateEngineTarget = Extract<EngineTargetResolution, { status: 'aggregate' }>

/** What an engine panel found at the other end of its binding. */
export type EnginePanelResolution =
  | (ResolvedEngineTarget & {
      /** This engine's metrics, with the no-model rule applied. */
      metric: EngineMetricReader
      /** One of this engine's series over the panel's own time window. */
      series: (name: EngineSeriesName) => DataPoint[]
    })
  /** The combined figures, read through the same reader and series shape a
   *  single engine uses — which is what lets one panel render either. */
  | (AggregateEngineTarget & {
      metric: EngineMetricReader
      series: (name: EngineSeriesName) => DataPoint[]
    })
  /** The engine resolved, and has no metrics yet — starting, or loading a model. */
  | { status: 'starting'; engine: EngineSnapshot }
  /** The engine is serving but its `/metrics` endpoint is disabled (llama.cpp
   *  started without `--metrics`), so no metrics can arrive. */
  | { status: 'metrics-disabled'; engine: EngineSnapshot }
  /** The engine resolved and is not serving; `detail` says why. */
  | { status: 'offline'; engine: EngineSnapshot; detail: string }
  | Exclude<EngineTargetResolution, { status: 'resolved' } | { status: 'aggregate' }>

/** Everything but a resolved target — what a panel hands to `EnginePanelNotice`. */
export type EnginePanelNoticeState = Exclude<
  EnginePanelResolution,
  { status: 'resolved' } | { status: 'aggregate' }
>

/**
 * Which engine a panel's binding names, and nothing more.
 *
 * This is the whole of what a panel needs when the engine's *own* state is the
 * thing it is there to show: the log panel streams a container that is starting,
 * crash-looping or serving nothing, which is exactly when its logs matter most,
 * so it must not be told "this engine has no metrics yet" instead. Panels that
 * chart metrics use `useEnginePanel`, which adds that gate.
 */
export function useEngineTarget(panel: DashboardPanel): EngineTargetResolution {
  const snapshot = useLatestSnapshot()
  const { chosen, source } = usePageSelection()

  return useMemo(() => {
    if (!snapshot) return { status: 'waiting' }

    const engines = snapshot.engines
    const resolution = resolveEngineBinding(
      panel.binding,
      engines,
      pageSelection(snapshot, chosen, source).engineTarget,
    )
    if (resolution.status === 'aggregate') {
      const running = engines.filter((engine) => engine.status.type === 'Running').length
      // An aggregate over a host serving nothing is not a row of zeros — it is
      // the same "no inference engine running" state a single target has.
      return running === 0
        ? { status: 'unselected' }
        : { status: 'aggregate', running, total: engines.length, engines }
    }
    if (resolution.status !== 'resolved') return resolution

    return { status: 'resolved', engine: resolution.target, multiEngine: engines.length > 1 }
  }, [snapshot, chosen, source, panel.binding])
}

/**
 * An inference-timeline panel's whole subscription in one call: the target its
 * binding names, and the finished requests over the panel's own window — one
 * engine's, or, following a page configured for all models, every engine's
 * together. Every hook lives in here, above the caller's unresolved early
 * return — the same shape as `useGpuPanelSeries`; while unresolved, the
 * all-engines key keeps the subscription alive until a binding names one.
 *
 * Deliberately the raw target rather than `useEnginePanel`: requests are the
 * engine's own record of what it served, and they stay worth reading when it
 * has stopped serving — an engine that fell over an hour into a run is exactly
 * when an operator wants to see what it was doing beforehand.
 */
export function useEngineRequests(panel: DashboardPanel): {
  target: EngineTargetResolution
  requests: InferenceRequestData[]
} {
  const target = useEngineTarget(panel)
  const key = target.status === 'resolved' ? engineKey(target.engine) : undefined
  const requests = useInferenceRequests(key, panel.window)
  return { target, requests }
}

/**
 * One row of the row view: the engine, whether it can show numbers at all,
 * and — when it can — its own metric reader and history, keyed the way the
 * ingest side writes them, so a row charts the same series a pinned panel
 * charts for that engine.
 */
export interface EngineRowTarget {
  engine: EngineSnapshot
  key: string
  /** The engine's metrics, with the no-model rule applied. Null while the
   *  engine has nothing to read. */
  metric: EngineMetricReader | null
  /** This engine's series over the panel's own time window. Null while
   *  `metric` is null. */
  series: ((name: EngineSeriesName) => DataPoint[]) | null
  /** Why the row shows no numbers — starting, metrics disabled, or offline.
   *  Null when the engine is serving. */
  note: string | null
}

/**
 * The all-models target as rows: one per engine on the host, each with its
 * own numbers under its own name, in the panel's own box — the engine
 * counterpart of the multi-GPU body a multi-GPU host renders for a following
 * GPU panel.
 *
 * Returns `rows` exactly when the panel's target is the all-models aggregate,
 * which is when a following panel should divide across the engines instead of
 * naming one. For every other target it returns the target's own resolution
 * state, so a panel that also resolves a single engine can branch on either
 * hook in one render.
 */
export function useEngineRows(panel: DashboardPanel):
  | { status: 'rows'; rows: EngineRowTarget[] }
  | Exclude<EngineTargetResolution, { status: 'aggregate' }> {
  const store = useMetricsStore()
  const target = useEngineTarget(panel)

  return useMemo(() => {
    if (target.status !== 'aggregate') return target

    return {
      status: 'rows' as const,
      rows: target.engines.map((engine) => {
        const availability = engineAvailability(engine)
        const ready = availability.kind === 'ready'
        const key = engineKey(engine)
        return {
          engine,
          key,
          metric: ready ? engineMetricReader(engine) : null,
          series: ready
            ? (name: EngineSeriesName) => store.getChartData(engineSeries(name, key), panel.window)
            : null,
          note:
            availability.kind === 'ready'
              ? null
              : availability.kind === 'offline'
                ? availability.detail
                : availability.kind === 'starting'
                  ? 'Starting — no metrics yet.'
                  : 'Metrics are disabled on this engine.',
        }
      }),
    }
  }, [store, target, panel.window])
}

/**
 * What an engine panel renders on this host: its binding resolved against the
 * latest snapshot's engines, the reader for that target's current values, and
 * its chart series over the panel's own window.
 *
 * A following panel resolves to the page-level engine selection, so a page of
 * following panels moves to another engine together when the operator chooses
 * one — and, by default on a multi-engine host, divides across every engine
 * as one row each, the way a multi-GPU host divides across its GPUs. A pinned
 * panel resolves to its own engine and to nothing else — two panels pinned to
 * two engines sit side by side, and a pin to an engine that is gone says so
 * rather than showing the neighbour's numbers.
 *
 * Series are read from the store during render rather than through a per-series
 * subscription: an engine panel shows current values as well as a chart, so it
 * already re-renders on every ingest, and a subscription per series would buy
 * nothing but bookkeeping.
 */
export function useEnginePanel(panel: DashboardPanel): EnginePanelResolution {
  const store = useMetricsStore()
  const snapshot = useLatestSnapshot()
  const target = useEngineTarget(panel)
  const window = panel.window

  return useMemo(() => {
    if (target.status === 'aggregate') {
      // Recomputed from the snapshot the target was resolved against, so the
      // tiles and the target agree; the series were ingested under the
      // all-engines key by the same aggregation.
      const metrics = aggregateEngineMetrics(snapshot?.engines ?? [])
      if (!metrics) return { status: 'unselected' }

      return {
        ...target,
        metric: <K extends keyof EngineMetrics>(key: K) => metrics[key],
        series: (name) => store.getChartData(engineSeries(name, ALL_ENGINES_KEY), window),
      }
    }
    if (target.status !== 'resolved') return target

    const { engine } = target
    const availability = engineAvailability(engine)
    if (availability.kind === 'starting') return { status: 'starting', engine }
    if (availability.kind === 'metrics-disabled') return { status: 'metrics-disabled', engine }
    if (availability.kind === 'offline') {
      return { status: 'offline', engine, detail: availability.detail }
    }

    const key = engineKey(engine)
    return {
      ...target,
      metric: engineMetricReader(engine),
      series: (name) => store.getChartData(engineSeries(name, key), window),
    }
  }, [store, snapshot, target, window])
}
