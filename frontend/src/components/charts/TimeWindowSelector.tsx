import React from 'react'
import type { TimeWindow } from '@/types/events'

interface TimeWindowSelectorProps {
  value: TimeWindow
  onChange: (w: TimeWindow) => void
}

const OPTIONS: TimeWindow[] = ['5m', '10m', '15m']

export const TimeWindowSelector = React.memo(function TimeWindowSelector({
  value,
  onChange,
}: TimeWindowSelectorProps) {
  return (
    <div className="flex border border-zinc-700 rounded-md overflow-hidden">
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className={`px-3 py-1 text-sm ${
            value === option
              ? 'bg-zinc-700 text-zinc-50'
              : 'bg-transparent text-zinc-400'
          }`}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  )
})
