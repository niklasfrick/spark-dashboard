import { useState } from 'react'
import { useDismissablePopover } from '@/hooks/useDismissablePopover'
import { useLatestSnapshot } from '@/hooks/useMetricsStore'
import {
  pageSourceChoices,
  pageSourceFromChoice,
  type PageSource,
  type PageSourceChoice,
} from '@/lib/dashboard/pageSource'
import type { SaveOutcome } from '@/lib/dashboard/client'
import { BarButton } from './BarButton'

interface PageConfigProps {
  /** The page's stored source. Absent = automatic. */
  source?: PageSource
  /** No save can succeed on this instance; the standing banner says why. */
  readOnly: boolean
  /** Writes the choice to the document. Null puts the page back on automatic. */
  onChange: (source: PageSource | null) => Promise<SaveOutcome['status']>
}

/**
 * What this page shows by default: one model, all of them combined, or
 * whatever the host is serving — the page-level dial the `follow` bindings
 * were built to point at.
 *
 * It sits beside “Edit layout” but is deliberately not part of an edit
 * session: choosing what a page shows is a deliberate, named request like
 * renaming the page, so it is **written when it is made** (see
 * `lib/dashboard/pages`), and it works without opening a session that locks
 * the page list. The popover closes on a successful write and stays open over
 * a failed one, so the operator is looking at the choice that did not take.
 */
export function PageConfig({ source, readOnly, onChange }: PageConfigProps) {
  const { open, setOpen, toggle, containerRef } = useDismissablePopover<HTMLDivElement>()
  // One write at a time: the loser of a race would be written from a document
  // that never had the winner's change.
  const [busy, setBusy] = useState(false)

  const snapshot = useLatestSnapshot()
  const { value, choices } = pageSourceChoices(source, snapshot?.engines ?? [])

  const choose = async (choice: PageSourceChoice) => {
    if (busy || choice.value === value) return
    setBusy(true)
    const status = await onChange(pageSourceFromChoice(choice.value))
    setBusy(false)
    if (status === 'saved') setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative shrink-0">
      <BarButton onClick={toggle}>Page config</BarButton>

      {open && (
        <section
          aria-label="Page configuration"
          className="absolute right-0 top-full z-20 mt-1 w-72 rounded-md border border-white/[0.08] bg-[#0d0d10] p-2 shadow-xl flex flex-col gap-1.5"
        >
          <p className="text-[11px] text-zinc-500 leading-snug">
            What panels on this page show, unless they are pinned to an engine of their own.
          </p>

          {readOnly && (
            <p className="text-[11px] text-amber-300/90 leading-snug">
              This dashboard is read-only, so the page cannot be reconfigured.
            </p>
          )}

          <div className="flex flex-col gap-1" role="group" aria-label="Model shown">
            {choices.map((choice) => (
              <SourceOption
                key={choice.value}
                choice={choice}
                selected={choice.value === value}
                disabled={readOnly || busy}
                onChoose={() => void choose(choice)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function SourceOption({
  choice,
  selected,
  disabled,
  onChoose,
}: {
  choice: PageSourceChoice
  selected: boolean
  disabled: boolean
  onChoose: () => void
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={disabled}
      aria-pressed={selected}
      className={`w-full text-left px-2 py-1.5 rounded text-[11px] border transition-colors ${
        selected
          ? 'border-[#76B900]/50 bg-[#76B900]/10'
          : disabled
            ? 'border-white/[0.04] cursor-not-allowed'
            : 'border-white/[0.08] hover:bg-white/[0.06]'
      } ${
        // An absent target stays offered — hiding it is how a page silently
        // ends up showing something else — but it is marked as what it is.
        choice.absent
          ? 'text-amber-300'
          : disabled && !selected
            ? 'text-zinc-600'
            : selected
              ? 'text-zinc-100'
              : 'text-zinc-300 hover:text-zinc-100'
      }`}
    >
      {choice.label}
    </button>
  )
}
