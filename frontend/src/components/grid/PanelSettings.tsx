import { useState } from 'react'
import { useLatestSnapshot } from '@/hooks/useMetricsStore'
import { bindingChoices, bindingFromChoice } from '@/lib/dashboard/bindingChoices'
import type { PanelBinding } from '@/lib/dashboard/bindings'
import { defaultPanelTitle, panelBindingKind, panelUsesWindow } from '@/lib/dashboard/panels'
import type { DashboardPanel } from '@/lib/dashboard/schema'
import { snapshotGpus } from '@/lib/identity'
import { TIME_WINDOWS, type TimeWindow } from '@/types/events'
import { BarButton } from './BarButton'

interface PanelSettingsProps {
  panel: DashboardPanel
  onRename: (title: string) => void
  onWindowChange: (window: TimeWindow) => void
  onRepoint: (binding: PanelBinding) => void
  onRemove: () => void
  onClose: () => void
}

/**
 * What one panel is, as opposed to where it sits: its title, the span its chart
 * covers, and what it is pointed at.
 *
 * It is a row above the grid rather than a form inside the panel, because a
 * panel can legitimately be one cell tall and a form that size is unusable. The
 * panel being configured says so in its own frame, which is what ties the two
 * together.
 *
 * Removal lives here rather than as a button on the frame. There is no undo —
 * discarding the session is the substitute — so deleting a panel is worth the
 * second click that opening its settings costs.
 *
 * Only the controls that mean something for this panel are shown: a host-wide
 * panel has nothing to pin, and a log tail has no window to cover. A control
 * that changes nothing is worse than no control at all.
 */
export function PanelSettings({
  panel,
  onRename,
  onWindowChange,
  onRepoint,
  onRemove,
  onClose,
}: PanelSettingsProps) {
  // What the operator is typing, spaces and all. The stored title is trimmed —
  // a blank one means "never renamed" — so a field reading back from it would
  // swallow every space at the moment it was typed. Mounted per panel (the
  // caller keys it), so switching panels starts the field from that panel's
  // own title.
  const [draft, setDraft] = useState(panel.title ?? '')

  // The held snapshot, frozen with the rest of the page: the targets on offer
  // hold still while the operator is choosing between them.
  const snapshot = useLatestSnapshot()
  const source = bindingChoices(
    panelBindingKind(panel.type),
    panel.binding,
    snapshot ? snapshotGpus(snapshot) : [],
    snapshot?.engines ?? [],
  )

  return (
    <section
      aria-label="Panel settings"
      className="shrink-0 flex flex-wrap items-center gap-3 mb-2 px-2 py-1.5 rounded-md border border-[#76B900]/30 bg-white/[0.02]"
    >
      <Field label="Title">
        <input
          type="text"
          value={draft}
          // The type's own default, shown as the placeholder: clearing the
          // field is how a panel goes back to it, so it has to be visible.
          placeholder={defaultPanelTitle(panel.type)}
          onChange={(event) => {
            setDraft(event.target.value)
            onRename(event.target.value)
          }}
          className="w-44 bg-white/[0.03] border border-white/[0.06] rounded-md px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#76B900]/60"
        />
      </Field>

      {panelUsesWindow(panel.type) && (
        <Field label="Time window">
          <Select
            value={panel.window}
            onChange={(value) => onWindowChange(value as TimeWindow)}
            options={TIME_WINDOWS.map((window) => ({ value: window, label: window }))}
          />
        </Field>
      )}

      {source.choices.length > 0 && (
        <Field label="Source">
          <Select
            value={source.value}
            onChange={(value) => onRepoint(bindingFromChoice(value))}
            options={source.choices}
          />
        </Field>
      )}

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onRemove}
          className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 transition-colors"
        >
          Remove panel
        </button>
        <BarButton onClick={onClose}>Done</BarButton>
      </div>
    </section>
  )
}

/** A labelled control. The label wraps its input, so it names it without an id
 *  that would have to be unique across however many panels a page holds. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-zinc-500">
      <span className="leading-none">{label}</span>
      {children}
    </label>
  )
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string
  options: readonly { value: string; label: string; absent?: boolean }[]
  onChange: (value: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="bg-white/[0.03] border border-white/[0.06] rounded-md px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-[#76B900]/60 cursor-pointer"
    >
      {options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          // Kept selectable: a target that is not on this host is still what
          // the panel is pinned to, and hiding it is how a panel silently ends
          // up showing something else.
          className={option.absent ? 'bg-[#0d0d10] text-amber-300' : 'bg-[#0d0d10] text-zinc-200'}
        >
          {option.label}
        </option>
      ))}
    </select>
  )
}
