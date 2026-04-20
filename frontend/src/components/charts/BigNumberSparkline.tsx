import React from 'react'
import { ArrowUp, ArrowDown, Minus } from 'lucide-react'
import { Sparkline } from './Sparkline'

interface BigNumberSparklineProps {
  value: number | null
  history: number[]
  unit: string
  format: (v: number) => string
}

function computeTrend(
  value: number,
  history: number[],
): 'up' | 'down' | 'stable' {
  const recent = history.slice(-6, -1)
  if (recent.length === 0) return 'stable'
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length
  if (value > avg * 1.05) return 'up'
  if (value < avg * 0.95) return 'down'
  return 'stable'
}

const trendIcons = {
  up: <ArrowUp className="size-4 text-green-500" />,
  down: <ArrowDown className="size-4 text-red-400" />,
  stable: <Minus className="size-4 text-zinc-500" />,
}

export const BigNumberSparkline = React.memo(function BigNumberSparkline({
  value,
  history,
  unit,
  format,
}: BigNumberSparklineProps) {
  if (value === null) {
    return (
      <span
        className="text-zinc-600"
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 28,
          fontWeight: 700,
        }}
      >
        N/A
      </span>
    )
  }

  const trend = computeTrend(value, history)

  return (
    <div className="flex items-center gap-3">
      <span
        className="text-zinc-100"
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 28,
          fontWeight: 700,
        }}
      >
        {format(value)}
      </span>
      <span
        className="text-zinc-500"
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: 14,
          marginLeft: 3,
        }}
      >
        {unit}
      </span>
      {trendIcons[trend]}
      <Sparkline data={history} />
    </div>
  )
})
