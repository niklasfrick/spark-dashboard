export type RotationInterval = 3000 | 5000 | 10000 | 20000 | 'off'

interface TabRotationControlProps {
  value: RotationInterval
  onChange: (next: RotationInterval) => void
}

const OPTIONS: { value: RotationInterval; label: string }[] = [
  { value: 3000, label: '3s' },
  { value: 5000, label: '5s' },
  { value: 10000, label: '10s' },
  { value: 20000, label: '20s' },
  { value: 'off', label: 'Off' },
]

export function serializeRotationInterval(value: RotationInterval): string {
  return value === 'off' ? 'off' : String(value)
}

export function parseRotationInterval(raw: string | null | undefined): RotationInterval {
  if (raw === 'off') return 'off'
  const n = Number(raw)
  if (n === 3000 || n === 5000 || n === 10000 || n === 20000) return n
  return 10000
}

export function TabRotationControl({ value, onChange }: TabRotationControlProps) {
  return (
    <label className="shrink-0 flex items-center gap-1.5 text-[11px] text-zinc-500 cursor-pointer select-none">
      <span className="leading-none">Rotate</span>
      <div className="relative">
        <select
          aria-label="Tab rotation interval"
          value={serializeRotationInterval(value)}
          onChange={(e) => {
            onChange(parseRotationInterval(e.target.value))
            e.currentTarget.blur()
          }}
          className="appearance-none bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] rounded-md pl-2 pr-6 py-1 text-[11px] text-zinc-200 tabular-nums leading-none focus:outline-none focus:ring-1 focus:ring-[#76B900]/60 transition-colors"
        >
          {OPTIONS.map((opt) => (
            <option key={opt.label} value={serializeRotationInterval(opt.value)} className="bg-[#0d0d10] text-zinc-200">
              {opt.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 10 6"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 w-2.5 h-1.5 text-zinc-500 pointer-events-none"
        >
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </label>
  )
}
