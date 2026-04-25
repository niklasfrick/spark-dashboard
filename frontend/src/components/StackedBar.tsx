export interface BarSegment {
  value: number
  total: number
  color: string
  label: string
}

export function StackedBar({ segments }: { segments: BarSegment[] }) {
  const total = segments.length > 0 ? segments[0].total : 0
  if (total === 0) return null

  return (
    <div className="shrink-0">
      <div className="flex h-1.5 lg:h-2 2xl:h-2.5 rounded-full overflow-hidden">
        {segments.map((seg, i) => {
          const pct = (seg.value / total) * 100
          if (pct <= 0) return null
          return (
            <div
              key={i}
              className={seg.color}
              style={{ width: `${pct}%` }}
            />
          )
        })}
      </div>
      <div className="flex gap-x-1.5 lg:gap-x-2 gap-y-0 lg:gap-y-0.5 mt-0.5 lg:mt-1 flex-wrap">
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center gap-0.5 lg:gap-1">
            <span className={`inline-block w-1 h-1 lg:w-1.5 lg:h-1.5 rounded-full ${seg.color}`} />
            <span className="text-[8px] lg:text-[9px] 2xl:text-[10px] text-zinc-300 truncate">{seg.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
