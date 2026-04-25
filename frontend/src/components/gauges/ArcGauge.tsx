import React, { useId } from 'react'
import { NVIDIA_THEME, thresholdColor } from '@/lib/theme'

interface ArcGaugeProps {
  value: number
  max?: number
  label: string
  unit: string
  thresholds?: { warning: number; critical: number }
  /** Rendered size — number (px) or any CSS length (`"clamp(56px, 6vw, 96px)"`). */
  size?: number | string
  /** Override the displayed number in the gauge center (e.g. show watts instead of percentage) */
  displayValue?: number
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
}: ArcGaugeProps) {
  const filterId = useId()
  const svgSize = VIEWBOX
  const strokeWidth = Math.max(8, svgSize * 0.06)
  const radius = (svgSize - strokeWidth * 2) / 2
  const circumference = radius * 2 * Math.PI
  const arc = circumference * (270 / 360)
  const percent = Math.min(Math.max(value / max, 0), 1)
  const offset = arc - percent * arc
  const cx = svgSize / 2
  const cy = svgSize / 2

  const color = thresholds
    ? thresholdColor(value, thresholds.warning, thresholds.critical)
    : NVIDIA_THEME.accent

  // Render width/height: pass through string CSS lengths verbatim, otherwise px.
  const renderSize = typeof size === 'number' ? `${size}px` : size

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
          strokeLinecap="round"
          transform={`rotate(135 ${cx} ${cy})`}
        />
        {/* Value arc with subtle glow */}
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
          {Math.round(displayValue ?? value)}
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
      <span className="hidden lg:inline text-[10px] 2xl:text-[11px] text-zinc-300 -mt-0.5 truncate max-w-full">{label}</span>
    </div>
  )
})
