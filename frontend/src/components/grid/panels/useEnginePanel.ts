import { useMemo } from 'react'
import { useLatestSnapshot, useMetricsStore } from '@/hooks/useMetricsStore'
import { usePageSelection } from '@/hooks/usePageSelection'
import { resolveEngineBinding } from '@/lib/dashboard/bindings'
import { pageSelection } from '@/lib/dashboard/selection'
import { engineAvailability, engineMetricReader, type EngineMetricReader } from '@/lib/engineMetrics'
import { engineKey } from '@/lib/identity'
import { engineSeries, type DataPoint, type EngineSeriesName } from '@/lib/metricsHistoryStore'
import type { DashboardPanel } from '@/lib/dashboard/schema'
import type { EngineSnapshot } from '@/types/metrics'

/** What an engine panel found at the other end of its binding. */
export type EnginePanelResolution =
  /** No snapshot has arrived yet; there are no engines to resolve against. */
  | { status: 'waiting' }
  | {
      status: 'resolved'
      engine: EngineSnapshot
      /** True when the host runs more than one engine, and a panel therefore has
       *  to name the one it is showing. */
      multiEngine: boolean
      /** This engine's metrics, with the no-model rule applied. */
      metric: EngineMetricReader
      /** One of this engine's series over the panel's own time window. */
      series: (name: EngineSeriesName) => DataPoint[]
    }
  /** The engine resolved, and has no metrics yet — starting, or loading a model. */
  | { status: 'starting'; engine: EngineSnapshot }
  /** The engine resolved and is not serving; `detail` says why. */
  | { status: 'offline'; engine: EngineSnapshot; detail: string }
  | { status: 'missing'; requested: string }
  | { status: 'unselected' }
  | { status: 'unreadable' }

/** Everything but a resolved engine — what a panel hands to `EnginePanelNotice`. */
export type EnginePanelNoticeState = Exclude<EnginePanelResolution, { status: 'resolved' }>

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
  const snapshot = useLatestSnapshot()
  const { chosen } = usePageSelection()
  const window = panel.window

  return useMemo(() => {
    if (!snapshot) return { status: 'waiting' }

    const engines = snapshot.engines
    const resolution = resolveEngineBinding(
      panel.binding,
      engines,
      pageSelection(snapshot, chosen).engineEndpoint,
    )
    if (resolution.status !== 'resolved') return resolution

    const engine = resolution.target
    const availability = engineAvailability(engine)
    if (availability.kind === 'starting') return { status: 'starting', engine }
    if (availability.kind === 'offline') {
      return { status: 'offline', engine, detail: availability.detail }
    }

    const key = engineKey(engine)
    return {
      status: 'resolved',
      engine,
      multiEngine: engines.length > 1,
      metric: engineMetricReader(engine),
      series: (name) => store.getChartData(engineSeries(name, key), window),
    }
  }, [store, snapshot, chosen, panel.binding, window])
}
