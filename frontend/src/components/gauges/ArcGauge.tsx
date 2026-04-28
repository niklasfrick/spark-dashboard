import React, { useId } from 'react'
import { NVIDIA_THEME, thresholdColor } from '@/lib/theme'

export interface GaugeSegment {
  value: number
  total: number
  color: string
  label: string
}

interface ArcGaugeProps {
  value?: number
  max?: number
  label: string
  unit: string
  thresholds?: { warning: number; critical: number }
  /** Rendered size — number (px) or any CSS length (`"clamp(56px, 6vw, 96px)"`). */
  size?: number | string
  /** Override the displayed number in the gauge center (e.g. show watts instead of percentage) */
  displayValue?: number
  /** When provided, renders a multi-segment arc with a color legend instead of a single-value arc. */
  segments?: GaugeSegment[]
}

// Fixed internal viewBox; the SVG element scales to the user-supplied size.
const VIEWBOX = 208 // historical 160 * 1.3 — preserves visual proportions

export const ArcGauge = React.memo(function ArcGauge({
  value,
  max = 100,
  label,
  unit,
  thresholds,
  size = 160,
  displayValue,
  segments,
}: ArcGaugeProps) {
  const filterId = useId()
  const svgSize = VIEWBOX
  const strokeWidth = Math.max(8, svgSize * 0.06)
  const radius = (svgSize - strokeWidth * 2) / 2
  const circumference = radius * 2 * Math.PI
  const arc = circumference * (270 / 360)
  const cx = svgSize / 2
  const cy = svgSize / 2

  const renderSize = typeof size === 'number' ? `${size}px` : size

  const centerValue = (() => {
    if (displayValue !== undefined) return Math.round(displayValue)
    if (value !== undefined) return Math.round(value)
    if (segments && segments.length > 0) {
      const total = segments[0].total
      if (total === 0) return 0
      const used = segments
        .filter(s => s.label !== 'Free')
        .reduce((sum, s) => sum + s.value, 0)
      return Math.round((used / total) * 100)
    }
    return 0
  })()

  const segmentsToRender = segments?.filter(s => s.value > 0 && s.total > 0) ?? []

  return (
    <div className="flex flex-col items-center">
      <svg style={{ width: renderSize, height: renderSize }} viewBox={`0 0 ${svgSize} ${svgSize}`}>
        <defs>
          <filter id={filterId} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* Background track */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke={NVIDIA_THEME.gaugeTrack}
          strokeWidth={strokeWidth}
          strokeDasharray={`${arc} ${circumference}`}
          strokeLinecap="butt"
          transform={`rotate(135 ${cx} ${cy})`}
        />

        {segmentsToRender.length > 0 ? (
          segmentsToRender.map((seg, i) => {
            const pct = Math.min(Math.max(seg.value / seg.total, 0), 1)
            const segArcLen = pct * arc
            // Cumulative arc length of all preceding segments
            let cumLen = 0
            for (let j = 0; j < i; j++) {
              const prevPct = Math.min(Math.max(segmentsToRender[j].value / segmentsToRender[j].total, 0), 1)
              cumLen += prevPct * arc
            }
            return (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={radius}
                fill="none"
                stroke={seg.color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${segArcLen} ${circumference}`}
                strokeDashoffset={-cumLen}
                strokeLinecap={i === segmentsToRender.length - 1 ? 'round' : 'butt'}
                transform={`rotate(135 ${cx} ${cy})`}
                filter={pct > 0.03 ? `url(#${filterId})` : undefined}
                style={{ transition: 'stroke-dashoffset 500ms ease, stroke-dasharray 500ms ease' }}
              />
            )
          })
        ) : (
          /* Single-value arc (no segments) */
          (() => {
            const v = value ?? 0
            const percent = Math.min(Math.max(v / max, 0), 1)
            const offset = arc - percent * arc
            const color = thresholds
              ? thresholdColor(v, thresholds.warning, thresholds.critical)
              : NVIDIA_THEME.accent
            return (
              <circle
                cx={cx}
                cy={cy}
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${arc} ${circumference}`}
                strokeDashoffset={offset}
                strokeLinecap="round"
                transform={`rotate(135 ${cx} ${cy})`}
                filter={percent > 0.05 ? `url(#${filterId})` : undefined}
                style={{
                  transition: 'stroke-dashoffset 500ms ease, stroke 300ms ease',
                }}
                data-testid="arc-value"
              />
            )
          })()
        )}

        {/* Center value text */}
        <text
          x="50%"
          y="43%"
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-zinc-100"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: svgSize * 0.28,
            fontWeight: 700,
          }}
        >
          {centerValue}
        </text>
        {/* Unit text */}
        <text
          x="50%"
          y="60%"
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-zinc-500"
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: svgSize * 0.14,
          }}
        >
          {unit}
        </text>
      </svg>

      {segmentsToRender.length > 0 && (
        <div className="flex gap-x-1.5 lg:gap-x-2 gap-y-0.5 mt-0.5 lg:mt-1 flex-wrap justify-center">
          {segmentsToRender.map((seg, i) => (
            <div key={i} className="flex items-center gap-0.5 lg:gap-1">
              <span
                className="inline-block w-1 h-1 lg:w-1.5 lg:h-1.5 rounded-full"
                style={{ backgroundColor: seg.color }}
              />
              <span className="text-[8px] lg:text-[9px] 2xl:text-[10px] text-zinc-300 truncate">{seg.label}</span>
            </div>
          ))}
        </div>
      )}

      <span className="hidden lg:inline text-[10px] 2xl:text-[11px] text-zinc-300 -mt-0.5 truncate max-w-full">{label}</span>
    </div>
  )
})
