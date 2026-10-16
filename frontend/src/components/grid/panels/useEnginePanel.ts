import { useMemo } from 'react'
import { useInferenceRequests, useLatestSnapshot, useMetricsStore } from '@/hooks/useMetricsStore'
import { usePageSelection } from '@/hooks/usePageSelection'
import { resolveEngineBinding } from '@/lib/dashboard/bindings'
import { panelMetricGroups } from '@/lib/dashboard/panels'
import { pageSelection } from '@/lib/dashboard/selection'
import {
  aggregateEngines,
  asEngineMetrics,
  panelCoverage,
  type GroupCoverage,
} from '@/lib/engineAggregate'
import {
  engineAvailability,
  engineMetricReader,
  reportedMetricGroups,
  type EngineMetricReader,
} from '@/lib/engineMetrics'
import { engineKey } from '@/lib/identity'
import {
  ALL_ENGINES_KEY,
  engineSeries,
  type DataPoint,
  type EngineSeriesName,
} from '@/lib/metricsHistoryStore'
import type { DashboardPanel } from '@/lib/dashboard/schema'
import type {
  EngineMetrics,
  EngineSnapshot,
  InferenceRequestData,
  MetricGroup,
} from '@/types/metrics'

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
  | { status: 'aggregate'; running: number; total: number }
  | { status: 'missing'; requested: string }
  | { status: 'unselected' }
  | { status: 'unreadable' }

/** An engine a panel resolved its binding to. */
export type ResolvedEngineTarget = Extract<EngineTargetResolution, { status: 'resolved' }>

/** The all-engines aggregate a panel resolved its binding to. */
export type AggregateEngineTarget = Extract<EngineTargetResolution, { status: 'aggregate' }>

/** What a panel reads off the target it resolved to. */
interface EngineReadings {
  /** The target's metrics; for one engine, with the no-model rule applied. */
  metric: EngineMetricReader
  /** One of the target's series over the panel's own time window. */
  series: (name: EngineSeriesName) => DataPoint[]
  /**
   * Whether the target reports a metric group. A panel showing several groups
   * asks this per tile: a tile whose group is not reported keeps its slot and
   * reads "not reported" — never a zero or a dash — and its chart line is not
   * drawn. A panel whose groups are all unreported never gets here.
   */
  reports: (group: MetricGroup) => boolean
}

/** What an engine panel found at the other end of its binding. */
export type EnginePanelResolution =
  | (ResolvedEngineTarget & EngineReadings)
  /** The combined figures, read through the same reader and series shape a
   *  single engine uses — which is what lets one panel render either. Each
   *  figure combines only the engines that report its group; `coverage` says
   *  how many that is, per group the panel shows. */
  | (AggregateEngineTarget & EngineReadings & { coverage: GroupCoverage })
  /**
   * The engine resolved, and reports none of the metric groups the panel shows
   * — a property of the engine rather than a moment in its life, so the panel
   * says so in place of its data and keeps its slot (ADR-0004).
   */
  | { status: 'not-reported'; engine: EngineSnapshot; groups: readonly MetricGroup[] }
  /**
   * The all-models counterpart of `not-reported`: engines are serving, and none
   * of them reports any of the groups the panel shows — so the combination has
   * nothing to combine, and the panel says so rather than showing a zero.
   */
  | { status: 'not-reported-by-any'; groups: readonly MetricGroup[] }
  /**
   * The engine resolved and is serving, but runs with its metrics endpoint
   * switched off by a launch flag. Not the state above — the engine *would*
   * report these groups, they are merely unswitched-on — so the panel names
   * the flag instead of calling the engine silent (ADR-0004).
   */
  | { status: 'metrics-off'; engine: EngineSnapshot; flag: string }
  /**
   * The engine resolved and is serving, and its metrics endpoint refused the
   * dashboard for want of the engine's API key. Neither `not-reported` nor
   * `metrics-off`: the metrics exist and are on — the remedy is a key on the
   * dashboard's side, said the way a refused `/v1/models` says it.
   */
  | { status: 'metrics-refused'; engine: EngineSnapshot }
  /** The engine resolved, and has no metrics yet — starting, or loading a model. */
  | { status: 'starting'; engine: EngineSnapshot }
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
        : { status: 'aggregate', running, total: engines.length }
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
 * What an engine panel renders on this host: its binding resolved against the
 * latest snapshot's engines, the reader for that target's current values, and
 * its chart series over the panel's own window.
 *
 * A following panel resolves to the page-level engine selection, so a page of
 * following panels shows one engine coherently and moves to another together —
 * or, on a page configured for all models, shows the combined figures. A pinned
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
  const groups = panelMetricGroups(panel.type)

  return useMemo(() => {
    if (target.status === 'aggregate') {
      // Recomputed from the snapshot the target was resolved against, so the
      // tiles and the target agree; the series were ingested under the
      // all-engines key by the same aggregation.
      const aggregate = aggregateEngines(snapshot?.engines ?? [])
      const metrics = asEngineMetrics(aggregate)
      if (!metrics) return { status: 'unselected' }

      // A group the combination reports is one at least one running engine
      // enters — by declaration, so a host running only vLLM reports every
      // group, exactly as the combination always has.
      const { coverage } = aggregate
      const reports = (group: MetricGroup) => coverage.included[group] > 0
      if (groups.length > 0 && !groups.some(reports)) {
        return { status: 'not-reported-by-any', groups }
      }

      return {
        ...target,
        metric: <K extends keyof EngineMetrics>(key: K) => metrics[key],
        series: (name) => store.getChartData(engineSeries(name, ALL_ENGINES_KEY), window),
        reports,
        coverage: panelCoverage(coverage, groups),
      }
    }
    if (target.status !== 'resolved') return target

    const { engine } = target
    // Asked before any other engine state: "has no metrics yet" would promise
    // data that is coming, and "does not report" would blame the engine —
    // while the truth is a launch flag the operator can act on today. A
    // starting engine is not at risk of the wrong message: the flag is only
    // latched by a `/metrics` answer, and a server that is not up yet refuses
    // the connection instead of answering it.
    if (engine.metrics_off) {
      return { status: 'metrics-off', engine, flag: engine.metrics_off }
    }
    // On the same terms: the backend carries the refusal only while the engine
    // runs, and no traffic or relaunch fixes it — only the engine's API key.
    if (engine.metrics_error === 'AuthRequired') {
      return { status: 'metrics-refused', engine }
    }

    const reported = reportedMetricGroups(engine)
    // Asked before whether the engine is serving: "does not report" is true in
    // every state the engine can be in, while "is not running" or "has no
    // metrics yet" would promise the panel fills once that passes.
    if (groups.length > 0 && !groups.some((group) => reported.has(group))) {
      return { status: 'not-reported', engine, groups }
    }

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
      reports: (group) => reported.has(group),
    }
  }, [store, snapshot, target, window, groups])
}
