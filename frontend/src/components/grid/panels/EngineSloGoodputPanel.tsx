import { GoodputTile } from '@/components/engines/EngineCardPrimitives'
import { SloSettingsControl } from '@/components/engines/SloSettingsControl'
import { useSloSettings } from '@/hooks/useSloSettings'
import { engineKey } from '@/lib/identity'
import { combinedGoodput, formatSloThreshold, recomputeGoodputPct } from '@/lib/slo'
import { EnginePanelBody } from './EnginePanelBody'
import { engineLabel } from './engineLabel'
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
 */
export function EngineSloGoodputPanel({ panel }: PanelContentProps) {
  const resolution = useEnginePanel(panel)
  const engine = resolution.status === 'resolved' ? resolution.engine : null
  const {
    thresholds,
    setThresholds,
    reset,
    isCustomized,
  } = useSloSettings(engine && engineKey(engine), engine?.model?.name ?? null)

  if (resolution.status !== 'resolved') return <EnginePanelNotice resolution={resolution} />

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
      label={engineLabel(resolution)}
      actions={
        <SloSettingsControl
          thresholds={thresholds}
          isCustomized={isCustomized}
          disabled={resolution.engine.model === null}
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
