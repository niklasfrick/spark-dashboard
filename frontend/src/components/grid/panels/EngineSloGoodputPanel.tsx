import { GoodputTile } from '@/components/engines/EnginePanelPrimitives'
import { SloSettingsControl } from '@/components/engines/SloSettingsControl'
import { useSloSettings } from '@/hooks/useSloSettings'
import { engineKey } from '@/lib/identity'
import { combinedGoodput, formatSloThreshold, recomputeGoodputPct } from '@/lib/slo'
import { EnginePanelBody } from './EnginePanelBody'
import { engineIdentity } from './engineLabel'
import { EnginePanelNotice } from './PanelNotice'
import { useEnginePanel } from './useEnginePanel'
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
 *
 * Goodput is read off a latency's percentiles histogram, so each latency's tile
 * follows its own percentiles group: one the engine does not report keeps its
 * slot, says "not reported", and stays out of the combined figure — which is
 * itself not reported when none of the latencies it combines is (ADR-0004).
 */
export function EngineSloGoodputPanel({ panel }: PanelContentProps) {
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

  const { metric, reports } = resolution
  const ttftReported = reports('TtftPercentiles')
  const itlReported = reports('ItlPercentiles')
  const e2eReported = reports('E2ePercentiles')
  const tpotReported = reports('TpotPercentiles')
  const ttft = ttftReported
    ? (recomputeGoodputPct(metric('ttft_buckets'), thresholds.ttftMs) ?? metric('ttft_goodput_pct'))
    : null
  const itl = itlReported
    ? (recomputeGoodputPct(metric('itl_buckets'), thresholds.itlMs) ?? metric('itl_goodput_pct'))
    : null
  const e2e = e2eReported
    ? (recomputeGoodputPct(metric('e2e_buckets'), thresholds.e2eMs) ?? metric('e2e_goodput_pct'))
    : null
  const tpot = tpotReported
    ? (recomputeGoodputPct(metric('tpot_buckets'), thresholds.tpotMs) ?? metric('tpot_goodput_pct'))
    : null

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
            <GoodputTile
              label="Combined"
              pct={combinedGoodput(ttft, itl, e2e)}
              emphasize
              notReported={!ttftReported && !itlReported && !e2eReported}
            />
          </div>
          <GoodputTile
            label={`TTFT ≤ ${formatSloThreshold(thresholds.ttftMs)}`}
            pct={ttft}
            notReported={!ttftReported}
          />
          <GoodputTile
            label={`ITL ≤ ${formatSloThreshold(thresholds.itlMs)}`}
            pct={itl}
            notReported={!itlReported}
          />
          <GoodputTile
            label={`TPOT ≤ ${formatSloThreshold(thresholds.tpotMs)}`}
            pct={tpot}
            notReported={!tpotReported}
          />
          <GoodputTile
            label={`E2E ≤ ${formatSloThreshold(thresholds.e2eMs)}`}
            pct={e2e}
            notReported={!e2eReported}
          />
        </div>
      }
    />
  )
}
