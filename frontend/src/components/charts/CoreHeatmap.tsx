import React, { useState, useCallback } from 'react'
import type { CoreMetrics } from '@/types/metrics'

interface CoreHeatmapProps {
  cores: CoreMetrics[]
}

function coreColor(usage: number): string {
  if (usage >= 90) return '#ef4444'
  if (usage >= 70) return '#eab308'
  if (usage >= 40) return '#76B900'
  if (usage >= 10) return '#365314'
  return '#27272a'
}

export const CoreHeatmap = React.memo(function CoreHeatmap({ cores }: CoreHeatmapProps) {
  const [tooltip, setTooltip] = useState<{ coreId: number; usage: number; x: number; y: number } | null>(null)

  const handleMouseEnter = useCallback((core: CoreMetrics, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setTooltip({ coreId: core.id, usage: core.usage_percent, x: rect.left + rect.width / 2, y: rect.top })
  }, [])

  const handleMouseLeave = useCallback(() => setTooltip(null), [])

  // Wide grid: more columns = fewer rows = less vertical space
  const cols = Math.ceil(Math.sqrt(cores.length * 4))

  return (
    <div className="relative">
      <h3 className="text-[10px] font-medium text-zinc-500 mb-0.5">Core Heatmap</h3>
      <div
        className="grid w-full"
        style={{
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: '1px',
        }}
      >
        {cores.map((core) => (
          <div
            key={core.id}
            className="h-[12px] rounded-[1px] transition-colors duration-300"
            style={{ backgroundColor: coreColor(core.usage_percent) }}
            onMouseEnter={(e) => handleMouseEnter(core, e)}
            onMouseLeave={handleMouseLeave}
          />
        ))}
      </div>
      {tooltip && (
        <div
          className="fixed z-50 bg-[#1a1a1e] border border-white/[0.06] rounded px-2 py-1 text-xs pointer-events-none -translate-x-1/2 -translate-y-full -mt-1"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <span className="text-zinc-400">Core {tooltip.coreId}:</span>{' '}
          <span className="text-zinc-100 font-semibold">{Math.round(tooltip.usage)}%</span>
        </div>
      )}
    </div>
  )
})
