import React from 'react'
import { LineChart, Line } from 'recharts'
import { NVIDIA_THEME } from '@/lib/theme'

interface SparklineProps {
  data: number[]
  color?: string
  width?: number
  height?: number
}

const SPARK_POINTS = 30

export const Sparkline = React.memo(function Sparkline({
  data,
  color = NVIDIA_THEME.chartLine,
  width = 64,
  height = 32,
}: SparklineProps) {
  // Pad to fixed point count for smooth CSS d transitions
  let padded = data
  if (data.length > 0 && data.length < SPARK_POINTS) {
    const pad = Array(SPARK_POINTS - data.length).fill(data[0])
    padded = [...pad, ...data]
  } else if (data.length > SPARK_POINTS) {
    padded = data.slice(-SPARK_POINTS)
  }
  const sparkData = padded.map((v, i) => ({ i, v }))

  return (
    <LineChart width={width} height={height} data={sparkData}>
      <Line
        type="monotone"
        dataKey="v"
        stroke={color}
        strokeWidth={1.5}
        dot={false}
        isAnimationActive={false}
      />
    </LineChart>
  )
})
