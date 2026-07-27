/**
 * Toggle plus interval dropdown for engine tab auto-rotation.
 *
 * The rotation state's types and pure helpers live in `@/lib/rotation` so
 * this file exports only its component.
 */

import {
  parseInterval,
  serializeInterval,
  type RotationInterval,
} from '@/lib/rotation'

interface TabRotationControlProps {
  enabled: boolean
  interval: RotationInterval
  onEnabledChange: (next: boolean) => void
  onIntervalChange: (next: RotationInterval) => void
}

const OPTIONS: { value: RotationInterval; label: string }[] = [
  { value: 3000, label: '3s' },
  { value: 5000, label: '5s' },
  { value: 10000, label: '10s' },
  { value: 20000, label: '20s' },
]

export function TabRotationControl({
  enabled,
  interval,
  onEnabledChange,
  onIntervalChange,
}: TabRotationControlProps) {
  return (
    <div className="shrink-0 flex items-center gap-2 text-[11px] text-zinc-500 select-none">
      <span className="leading-none">Auto-Rotate</span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Toggle tab rotation"
        onClick={() => onEnabledChange(!enabled)}
        className={`relative inline-flex h-[14px] w-6 shrink-0 items-center rounded-full border transition-colors focus:outline-none focus:ring-1 focus:ring-[#76B900]/60 ${
          enabled
            ? 'bg-[#76B900]/80 border-[#76B900]/60'
            : 'bg-white/[0.06] border-white/[0.08] hover:bg-white/[0.09]'
        }`}
      >
        <span
          aria-hidden="true"
          className={`inline-block h-[10px] w-[10px] rounded-full bg-white shadow-sm transition-transform ${
            enabled ? 'translate-x-[11px]' : 'translate-x-[1px]'
          }`}
        />
      </button>
      <div className="relative">
        <select
          aria-label="Tab rotation interval"
          disabled={!enabled}
          value={serializeInterval(interval)}
          onChange={(e) => {
            onIntervalChange(parseInterval(e.target.value))
            e.currentTarget.blur()
          }}
          className={`appearance-none border rounded-md pl-2 pr-6 py-1 text-[11px] tabular-nums leading-none focus:outline-none focus:ring-1 focus:ring-[#76B900]/60 transition-colors ${
            enabled
              ? 'bg-white/[0.03] hover:bg-white/[0.06] border-white/[0.06] text-zinc-200 cursor-pointer'
              : 'bg-white/[0.02] border-white/[0.04] text-zinc-500 cursor-not-allowed opacity-60'
          }`}
        >
          {OPTIONS.map((opt) => (
            <option key={opt.label} value={serializeInterval(opt.value)} className="bg-[#0d0d10] text-zinc-200">
              {opt.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 10 6"
          className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-2.5 h-1.5 pointer-events-none transition-colors ${
            enabled ? 'text-zinc-500' : 'text-zinc-700'
          }`}
        >
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  )
}
