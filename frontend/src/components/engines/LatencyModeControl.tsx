/**
 * Dropdown for the global latency statistic (avg / p50 / p95 / p99).
 *
 * The mode's type and its pure helpers live in `@/lib/latencyMode` so this
 * file exports only its component.
 */

import { isLatencyMode, type LatencyMode } from '@/lib/latencyMode'

const OPTIONS: { value: LatencyMode; label: string }[] = [
  { value: 'avg', label: 'Avg' },
  { value: 'p50', label: 'p50' },
  { value: 'p95', label: 'p95' },
  { value: 'p99', label: 'p99' },
]

interface LatencyModeControlProps {
  mode: LatencyMode
  onModeChange: (next: LatencyMode) => void
}

export function LatencyModeControl({ mode, onModeChange }: LatencyModeControlProps) {
  return (
    <div className="shrink-0 flex items-center gap-2 text-[11px] text-zinc-500 select-none">
      <span className="leading-none">Statistic</span>
      <div className="relative">
        <select
          aria-label="Statistic display mode"
          value={mode}
          onChange={(e) => {
            const next = e.target.value
            if (isLatencyMode(next)) onModeChange(next)
            e.currentTarget.blur()
          }}
          className="appearance-none border rounded-md pl-2 pr-6 py-1 text-[11px] tabular-nums leading-none focus:outline-none focus:ring-1 focus:ring-[#76B900]/60 transition-colors bg-white/[0.03] hover:bg-white/[0.06] border-white/[0.06] text-zinc-200 cursor-pointer"
        >
          {OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-[#0d0d10] text-zinc-200">
              {opt.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 10 6"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 w-2.5 h-1.5 pointer-events-none text-zinc-500"
        >
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  )
}
