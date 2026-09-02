import { TimeSeriesChart } from '@/components/charts/TimeSeriesChart'
import { AnimatedCounter } from '@/components/engines/AnimatedCounter'
import { KvBar, MetricTile, TrendArrow } from '@/components/engines/EngineCardPrimitives'
import { computeTrend } from '@/lib/engineStats'
import { formatCompactTokens } from '@/lib/format'
import { EnginePanelBody } from './EnginePanelBody'
import { engineLabel, engineLogo } from './engineLabel'
import { EnginePanelNotice } from './PanelNotice'
import { useEnginePanel } from './useEnginePanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * How much of the engine's KV cache is in use, and how much of the prompt
 * traffic the prefix cache is answering.
 *
 * The two belong together: a KV cache filling up is what limits how many
 * requests an engine can hold, and prefix hits are what keep it from filling.
 */
export function EngineCachePanel({ panel }: PanelContentProps) {
  const resolution = useEnginePanel(panel)
  if (resolution.status !== 'resolved') return <EnginePanelNotice resolution={resolution} />

  const { metric, series } = resolution
  const kvPercent = metric('kv_cache_percent')
  const prefixHit = metric('prefix_cache_hit_rate')
  const kvSeries = series('kvCache')

  return (
    <EnginePanelBody
      label={engineLabel(resolution)}
      logo={engineLogo(resolution)}
      tiles={
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-1.5">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider truncate">
                KV Cache
              </span>
              <div className="flex items-baseline">
                <span className="text-lg xl:text-xl 2xl:text-2xl min-[1920px]:text-3xl font-bold text-zinc-100 font-mono tabular-nums leading-none">
                  {kvPercent !== null ? Math.round(kvPercent) : '--'}
                </span>
                <span className="text-xs text-zinc-500 ml-1">%</span>
                {/* A filling cache is bad news, so the arrow's colours invert. */}
                <TrendArrow trend={computeTrend(kvSeries)} invertColor />
              </div>
              {kvPercent !== null && <KvBar percent={kvPercent} />}
            </div>
            <MetricTile
              label="Prefix Hit"
              value={prefixHit !== null ? `${Math.round(prefixHit)}` : '--'}
              unit="%"
            />
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[10px] 2xl:text-xs font-medium text-zinc-400 uppercase tracking-wider truncate">
              Prefix Queries
            </span>
            <AnimatedCounter
              value={metric('prefix_cache_queries_total')}
              format={formatCompactTokens}
              className="text-lg xl:text-xl 2xl:text-2xl min-[1920px]:text-3xl font-bold text-zinc-100 font-mono tabular-nums leading-none"
            />
          </div>
        </div>
      }
      chart={
        <TimeSeriesChart
          hideTooltipLabel
          series={[
            { data: kvSeries, label: 'KV Cache', color: '#76B900' },
            { data: series('prefixCacheHit'), label: 'Prefix Hit', color: '#3b82f6' },
          ]}
          yDomain={[0, 100]}
          unit="%"
          height="100%"
        />
      }
    />
  )
}
