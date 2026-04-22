export function MetricRow({
  label,
  value,
  unit,
  color,
  tooltip,
}: {
  label: string
  value: string | null
  unit?: string
  color?: string
  tooltip?: string
}) {
  const isNA = value === null || value === 'N/A'
  const valueColor = isNA ? 'text-zinc-600' : (color || 'text-zinc-100')

  return (
    <div className="flex justify-between items-baseline gap-4" title={tooltip}>
      <span className="text-xs text-zinc-400">{label}</span>
      <span className={`font-mono font-semibold text-sm ${valueColor}`}>
        {isNA ? 'N/A' : value}
        {!isNA && unit && <span className="text-xs font-normal text-zinc-500 ml-1">{unit}</span>}
      </span>
    </div>
  )
}
