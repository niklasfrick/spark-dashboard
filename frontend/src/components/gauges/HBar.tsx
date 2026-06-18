import React from 'react'
import { NVIDIA_THEME, thresholdColor } from '@/lib/theme'
import type { GaugeSegment } from './ArcGauge'

interface HBarProps {
  value?: number
  max?: number
  label: string
  unit: string
  thresholds?: { warning: number; critical: number }
  /** Override the displayed number (e.g. show watts instead of percentage). */
  displayValue?: number
  /** When provided, renders a stacked multi-segment bar with a legend. */
  segments?: GaugeSegment[]
}

/**
 * Compact horizontal-bar alternative to {@link ArcGauge}, used by the hardware
 * cards when vertical space is too tight for a square gauge. Accepts the same
 * data shape (single value+threshold, or stacked segments) so a card can swap
 * between the two without reshaping its props.
 */
export const HBar = React.memo(function HBar({
  value,
  max = 100,
  label,
  unit,
  thresholds,
  displayValue,
  segments,
}: HBarProps) {
  const segs = segments?.filter((s) => s.value > 0 && s.total > 0) ?? []

  const centerValue = (() => {
    if (displayValue !== undefined) return Math.round(displayValue)
    if (value !== undefined) return Math.round(value)
    if (segs.length > 0) {
      const total = segs[0].total
      if (total === 0) return 0
      const used = segs.filter((s) => s.label !== 'Free').reduce((sum, s) => sum + s.value, 0)
      return Math.round((used / total) * 100)
    }
    return 0
  })()

  return (
    <div className="flex flex-col gap-0.5 lg:gap-1 w-full min-w-0">
      <div className="flex items-baseline gap-2 min-w-0">
        {label && (
          <span className="text-[9px] lg:text-[10px] text-zinc-400 uppercase tracking-wider truncate min-w-0">
            {label}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono font-bold tabular-nums text-xs lg:text-sm 2xl:text-base text-zinc-100 leading-none">
          {centerValue}
          <span className="ml-0.5 text-[9px] lg:text-[10px] text-zinc-500">{unit}</span>
        </span>
      </div>
      <div className="flex h-1.5 lg:h-2 w-full rounded-full overflow-hidden bg-zinc-700/40">
        {segs.length > 0 ? (
          segs.map((seg, i) => (
            <div
              key={i}
              className="h-full transition-all duration-500"
              style={{ width: `${Math.min(100, (seg.value / seg.total) * 100)}%`, backgroundColor: seg.color }}
            />
          ))
        ) : (
          (() => {
            const v = value ?? 0
            const percent = Math.min(Math.max(v / max, 0), 1) * 100
            const color = thresholds
              ? thresholdColor(v, thresholds.warning, thresholds.critical)
              : NVIDIA_THEME.accent
            return (
              <div
                className="h-full transition-all duration-500"
                style={{ width: `${percent}%`, backgroundColor: color }}
                data-testid="hbar-fill"
              />
            )
          })()
        )}
      </div>
      {segs.length > 0 && (
        <div className="flex flex-wrap gap-x-1.5 gap-y-0.5">
          {segs.map((seg, i) => (
            <div key={i} className="flex items-center gap-0.5 min-w-0">
              <span className="inline-block w-1 h-1 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
              <span className="text-[8px] lg:text-[9px] text-zinc-300 truncate">{seg.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})
