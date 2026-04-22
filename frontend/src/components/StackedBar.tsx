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
    <div>
      <div className="flex h-2.5 rounded-full overflow-hidden">
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
      <div className="flex gap-3 mt-1.5 flex-wrap">
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center gap-1">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${seg.color}`} />
            <span className="text-[10px] text-zinc-300">{seg.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
