import { GoodputTile } from '@/components/engines/EnginePanelPrimitives'
import { SloSettingsControl } from '@/components/engines/SloSettingsControl'
import { useSloSettings } from '@/hooks/useSloSettings'
import { engineKey } from '@/lib/identity'
import { supportsCapability } from '@/lib/engineCapabilities'
import { combinedGoodput, DEFAULT_SLO, formatSloThreshold, recomputeGoodputPct } from '@/lib/slo'
import { EnginePanelBody } from './EnginePanelBody'
import { engineIdentity } from './engineLabel'
import { EnginePanelNotice, PanelNotice } from './PanelNotice'
import { MultiEnginePanelBody } from './MultiEnginePanelBody'
import { useEnginePanel, useEngineRows } from './useEnginePanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * The share of requests meeting each latency objective, and the combined
 * headline.
 *
 * Goodput is recomputed here from the engine's histogram buckets rather than
 * read off the backend's percentages, so an operator who tightens a threshold
 * sees the number move. The backend's own figure is the fallback for an engine
 * that is not shipping buckets yet — warming up, or with no traffic — so the
 * tiles say something rather than nothing.
 *
 * Thresholds are per model and stored in the browser, which is why the control
 * sits in the panel: they are one operator's reading of their own workload, not
 * part of the shared dashboard document.
 */
export function EngineSloGoodputPanel({ panel }: PanelContentProps) {
  const rows = useEngineRows(panel)
  const resolution = useEnginePanel(panel)
  const engine = resolution.status === 'resolved' ? resolution.engine : null
  // Thresholds are per model, so the aggregate reads at the defaults: a page
  // showing all models has no one model whose stored thresholds could honestly
  // caption a combined figure. The control below is disabled on the same terms.
  const {
    thresholds,
    setThresholds,
    reset,
    isCustomized,
  } = useSloSettings(engine && engineKey(engine), engine?.model?.name ?? null)

  if (resolution.status !== 'resolved' && resolution.status !== 'aggregate') {
    return <EnginePanelNotice resolution={resolution} />
  }

  if (rows.status === 'rows') {
    // One row per engine, each scored against the default thresholds — the
    // panel's editor names one model's thresholds and there is no combined
    // threshold to read. An engine without latency percentiles cannot be
    // scored at all; its row says so instead of wearing a dash.
    return (
      <MultiEnginePanelBody
        seriesLabel="Goodput"
        rows={rows.rows}
        pick={(row) => {
          const metric = row.metric
          if (!metric) return { value: null, unit: '%', data: [] }
          if (!supportsCapability(row.engine.engine_type, 'goodput')) {
            return {
              value: null,
              unit: '%',
              note: 'This engine does not expose latency percentiles.',
              data: [],
            }
          }
          const ttft = recomputeGoodputPct(metric('ttft_buckets'), DEFAULT_SLO.ttftMs) ??
            metric('ttft_goodput_pct')
          const itl = recomputeGoodputPct(metric('itl_buckets'), DEFAULT_SLO.itlMs) ??
            metric('itl_goodput_pct')
          const e2e = recomputeGoodputPct(metric('e2e_buckets'), DEFAULT_SLO.e2eMs) ??
            metric('e2e_goodput_pct')
          const pct = combinedGoodput(ttft, itl, e2e)
          return {
            value: pct,
            displayValue: pct !== null ? `${Math.round(pct)}` : undefined,
            unit: '%',
            data: [],
          }
        }}
      />
    )
  }

  // Goodput is recomputed from latency histogram buckets; an engine that ships
  // none (llama.cpp) cannot be scored against an SLO, so the all-dashes grid
  // and its threshold editor would read as a fault. Say so instead.
  if (
    resolution.status === 'resolved' &&
    !supportsCapability(resolution.engine.engine_type, 'goodput')
  ) {
    return (
      <PanelNotice>
        Goodput needs latency percentiles, which this engine does not expose.
      </PanelNotice>
    )
  }

  const { metric } = resolution
  const ttft = recomputeGoodputPct(metric('ttft_buckets'), thresholds.ttftMs)
    ?? metric('ttft_goodput_pct')
  const itl = recomputeGoodputPct(metric('itl_buckets'), thresholds.itlMs)
    ?? metric('itl_goodput_pct')
  const e2e = recomputeGoodputPct(metric('e2e_buckets'), thresholds.e2eMs)
    ?? metric('e2e_goodput_pct')
  const tpot = recomputeGoodputPct(metric('tpot_buckets'), thresholds.tpotMs)
    ?? metric('tpot_goodput_pct')

  return (
    <EnginePanelBody
      identity={engineIdentity(resolution)}
      actions={
        <SloSettingsControl
          thresholds={thresholds}
          isCustomized={isCustomized}
          disabled={engine === null || engine.model === null}
          onChange={setThresholds}
          onReset={reset}
        />
      }
      tiles={
        <div className="grid grid-cols-2 gap-1.5">
          <div className="col-span-2">
            <GoodputTile label="Combined" pct={combinedGoodput(ttft, itl, e2e)} emphasize />
          </div>
          <GoodputTile label={`TTFT ≤ ${formatSloThreshold(thresholds.ttftMs)}`} pct={ttft} />
          <GoodputTile label={`ITL ≤ ${formatSloThreshold(thresholds.itlMs)}`} pct={itl} />
          <GoodputTile label={`TPOT ≤ ${formatSloThreshold(thresholds.tpotMs)}`} pct={tpot} />
          <GoodputTile label={`E2E ≤ ${formatSloThreshold(thresholds.e2eMs)}`} pct={e2e} />
        </div>
      }
    />
  )
}
