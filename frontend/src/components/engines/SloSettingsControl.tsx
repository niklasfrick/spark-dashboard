import { useEffect, useRef, useState } from 'react'
import { DEFAULT_SLO, type SloThresholds } from '@/lib/slo'

interface SloSettingsControlProps {
  thresholds: SloThresholds
  isCustomized: boolean
  disabled?: boolean
  onChange: (next: SloThresholds) => void
  onReset: () => void
}

interface FieldDraft {
  ttftMs: string
  itlMs: string
  e2eMs: string
}

function toDraft(t: SloThresholds): FieldDraft {
  return {
    ttftMs: String(t.ttftMs),
    itlMs: String(t.itlMs),
    e2eMs: String(t.e2eMs),
  }
}

function parseDraft(d: FieldDraft): SloThresholds | null {
  const ttftMs = Number(d.ttftMs)
  const itlMs = Number(d.itlMs)
  const e2eMs = Number(d.e2eMs)
  if (
    !Number.isFinite(ttftMs) || ttftMs <= 0 ||
    !Number.isFinite(itlMs) || itlMs <= 0 ||
    !Number.isFinite(e2eMs) || e2eMs <= 0
  ) {
    return null
  }
  return { ttftMs, itlMs, e2eMs }
}

export function SloSettingsControl({
  thresholds,
  isCustomized,
  disabled = false,
  onChange,
  onReset,
}: SloSettingsControlProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<FieldDraft>(() => toDraft(thresholds))
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Sync the local draft when external thresholds change (e.g. user
  // switches model and the hook reloads stored values).
  useEffect(() => {
    setDraft(toDraft(thresholds))
  }, [thresholds])

  // Click-outside + Escape close the popover.
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!containerRef.current) return
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const parsed = parseDraft(draft)
  const dirty =
    parsed !== null &&
    (parsed.ttftMs !== thresholds.ttftMs ||
      parsed.itlMs !== thresholds.itlMs ||
      parsed.e2eMs !== thresholds.e2eMs)

  const apply = () => {
    if (parsed === null) return
    onChange(parsed)
    setOpen(false)
  }

  const reset = () => {
    onReset()
    setDraft(toDraft(DEFAULT_SLO))
  }

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        aria-label="Edit SLO thresholds"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title="Edit SLO thresholds"
        className={`inline-flex items-center justify-center h-6 w-6 rounded-md border transition-colors focus:outline-none focus:ring-1 focus:ring-[#76B900]/60 ${
          disabled
            ? 'bg-white/[0.02] border-white/[0.04] text-zinc-600 cursor-not-allowed opacity-60'
            : isCustomized
              ? 'bg-[#76B900]/15 hover:bg-[#76B900]/25 border-[#76B900]/40 text-[#a4d930]'
              : 'bg-white/[0.04] hover:bg-white/[0.10] border-white/[0.10] text-zinc-300 hover:text-zinc-100'
        }`}
      >
        <GearIcon />
      </button>

      {open && !disabled && (
        <div
          role="dialog"
          aria-label="SLO threshold settings"
          className="absolute right-0 top-[calc(100%+4px)] z-50 w-[14rem] rounded-md border border-white/[0.08] bg-[#0d0d10]/95 backdrop-blur-sm shadow-xl p-3 text-[11px] text-zinc-200"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 mb-2">
            SLO Thresholds
          </div>
          <div className="flex flex-col gap-2">
            <SloField
              label="TTFT"
              unit="ms"
              value={draft.ttftMs}
              onChange={(ttftMs) => setDraft((d) => ({ ...d, ttftMs }))}
              onCommit={apply}
            />
            <SloField
              label="ITL"
              unit="ms"
              value={draft.itlMs}
              onChange={(itlMs) => setDraft((d) => ({ ...d, itlMs }))}
              onCommit={apply}
            />
            <SloField
              label="E2E"
              unit="ms"
              value={draft.e2eMs}
              onChange={(e2eMs) => setDraft((d) => ({ ...d, e2eMs }))}
              onCommit={apply}
            />
          </div>
          {parsed === null && (
            <div className="mt-2 text-[10px] text-amber-400">
              All values must be positive numbers.
            </div>
          )}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={!isCustomized}
              className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded border transition-colors ${
                isCustomized
                  ? 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.06]'
                  : 'border-white/[0.04] text-zinc-600 cursor-not-allowed opacity-60'
              }`}
            >
              Reset
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={!dirty || parsed === null}
              className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded border transition-colors ${
                dirty && parsed !== null
                  ? 'bg-[#76B900]/20 hover:bg-[#76B900]/30 border-[#76B900]/40 text-[#cfe98a]'
                  : 'border-white/[0.04] text-zinc-600 cursor-not-allowed opacity-60'
              }`}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

interface SloFieldProps {
  label: string
  unit: string
  value: string
  onChange: (next: string) => void
  onCommit: () => void
}

function SloField({ label, unit, value, onChange, onCommit }: SloFieldProps) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-zinc-400">{label}</span>
      <span className="inline-flex items-center gap-1">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onCommit()
            }
          }}
          className="w-16 text-right tabular-nums bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5 text-zinc-100 focus:outline-none focus:ring-1 focus:ring-[#76B900]/60"
        />
        <span className="text-[10px] text-zinc-500">{unit}</span>
      </span>
    </label>
  )
}

function GearIcon() {
  // Lucide-style settings/gear: 8 outward teeth around a center hole, all
  // strokes contained within the 24x24 viewBox so the icon never clips.
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  )
}
