import { useMemo } from 'react'
import { useInferenceRequests, useLatestSnapshot, useMetricsStore } from '@/hooks/useMetricsStore'
import { usePageSelection } from '@/hooks/usePageSelection'
import { resolveEngineBinding } from '@/lib/dashboard/bindings'
import { pageSelection } from '@/lib/dashboard/selection'
import { engineAvailability, engineMetricReader, type EngineMetricReader } from '@/lib/engineMetrics'
import { engineKey } from '@/lib/identity'
import { engineSeries, type DataPoint, type EngineSeriesName } from '@/lib/metricsHistoryStore'
import type { DashboardPanel } from '@/lib/dashboard/schema'
import type { EngineSnapshot, InferenceRequestData } from '@/types/metrics'

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
  | { status: 'missing'; requested: string }
  | { status: 'unselected' }
  | { status: 'unreadable' }

/** An engine a panel resolved its binding to. */
export type ResolvedEngineTarget = Extract<EngineTargetResolution, { status: 'resolved' }>

/** What an engine panel found at the other end of its binding. */
export type EnginePanelResolution =
  | (ResolvedEngineTarget & {
      /** This engine's metrics, with the no-model rule applied. */
      metric: EngineMetricReader
      /** One of this engine's series over the panel's own time window. */
      series: (name: EngineSeriesName) => DataPoint[]
    })
  /** The engine resolved, and has no metrics yet — starting, or loading a model. */
  | { status: 'starting'; engine: EngineSnapshot }
  /** The engine resolved and is not serving; `detail` says why. */
  | { status: 'offline'; engine: EngineSnapshot; detail: string }
  | Exclude<EngineTargetResolution, { status: 'resolved' }>

/** Everything but a resolved engine — what a panel hands to `EnginePanelNotice`. */
export type EnginePanelNoticeState = Exclude<EnginePanelResolution, { status: 'resolved' }>

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
  const { chosen } = usePageSelection()

  return useMemo(() => {
    if (!snapshot) return { status: 'waiting' }

    const engines = snapshot.engines
    const resolution = resolveEngineBinding(
      panel.binding,
      engines,
      pageSelection(snapshot, chosen).engineEndpoint,
    )
    if (resolution.status !== 'resolved') return resolution

    return { status: 'resolved', engine: resolution.target, multiEngine: engines.length > 1 }
  }, [snapshot, chosen, panel.binding])
}

/**
 * An inference-timeline panel's whole subscription in one call: the engine its
 * binding names, and that engine's finished requests over the panel's own
 * window. Every hook lives in here, above the caller's unresolved early return
 * — the same shape as `useGpuPanelSeries`; while unresolved, the all-engines
 * key keeps the subscription alive until a binding names one.
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
 * What an engine panel renders on this host: its binding resolved against the
 * latest snapshot's engines, the reader for that engine's current values, and
 * its chart series over the panel's own window.
 *
 * A following panel resolves to the page-level engine selection, so a page of
 * following panels shows one engine coherently and moves to another together.
 * A pinned panel resolves to its own engine and to nothing else — two panels
 * pinned to two engines sit side by side, and a pin to an engine that is gone
 * says so rather than showing the neighbour's numbers.
 *
 * Series are read from the store during render rather than through a per-series
 * subscription: an engine panel shows current values as well as a chart, so it
 * already re-renders on every ingest, and a subscription per series would buy
 * nothing but bookkeeping.
 */
export function useEnginePanel(panel: DashboardPanel): EnginePanelResolution {
  const store = useMetricsStore()
  const target = useEngineTarget(panel)
  const window = panel.window

  return useMemo(() => {
    if (target.status !== 'resolved') return target

    const { engine } = target
    const availability = engineAvailability(engine)
    if (availability.kind === 'starting') return { status: 'starting', engine }
    if (availability.kind === 'offline') {
      return { status: 'offline', engine, detail: availability.detail }
    }

    const key = engineKey(engine)
    return {
      ...target,
      metric: engineMetricReader(engine),
      series: (name) => store.getChartData(engineSeries(name, key), window),
    }
  }, [store, target, window])
}
