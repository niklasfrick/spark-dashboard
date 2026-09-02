import { useState } from 'react'
import { useDismissablePopover } from '@/hooks/useDismissablePopover'
import type { DashboardPage } from '@/lib/dashboard/schema'

interface PagesMenuProps {
  /** The page being viewed — the one this menu renames and deletes. */
  page: DashboardPage
  /** False for the only page there is: deleting it would leave nothing to show. */
  canDelete: boolean
  /** Nothing can be written on this instance; the standing banner says why. */
  readOnly: boolean
  /** A layout edit is open, so the page list must hold still until it is settled. */
  locked: boolean
  /** A page write is in flight; a second one would race it. */
  busy: boolean
  onCreate: () => void
  onRename: (name: string) => void
  onDelete: () => void
  onResetEverything: () => void
}

/**
 * Where a page is made, named, thrown away — and where the whole configuration
 * is reset.
 *
 * A menu rather than controls on the tabs themselves: renaming and deleting are
 * occasional, and a tab strip covered in affordances is a strip you cannot
 * click to switch pages, which is the thing it is for.
 *
 * These edits are **written when they are made**, unlike a layout change. A drag
 * is one of hundreds of intermediate positions and needs a session to hold it;
 * "create a page" is already the deliberate, named request that a save button
 * would only ask the operator to repeat.
 *
 * Reset is two-tiered, and only one tier is destructive. Deleting a page takes
 * that page; resetting takes everything and cannot be undone, so it asks first —
 * in place, because a confirmation the operator has to hunt for in a modal is
 * one they learn to dismiss without reading.
 */
export function PagesMenu({
  page,
  canDelete,
  readOnly,
  locked,
  busy,
  onCreate,
  onRename,
  onDelete,
  onResetEverything,
}: PagesMenuProps) {
  const { open, setOpen, toggle, containerRef } = useDismissablePopover<HTMLDivElement>()

  const disabled = readOnly || locked || busy
  const reason = readOnly
    ? 'This dashboard is read-only, so its pages cannot be changed.'
    : locked
      ? 'Save or discard your layout changes to add, rename or delete pages.'
      : null

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-white/[0.08] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors"
      >
        Pages
      </button>

      {open && (
        <section
          aria-label="Page settings"
          className="absolute right-0 top-full z-20 mt-1 w-64 rounded-md border border-white/[0.08] bg-[#0d0d10] p-2 shadow-xl flex flex-col gap-2"
        >
          {reason && <p className="text-[11px] text-amber-300/90 leading-snug">{reason}</p>}

          <RenameField
            // Keyed by the page, so switching pages starts the field from the
            // page now being viewed rather than from the last one.
            key={page.id}
            page={page}
            disabled={disabled}
            onRename={onRename}
          />

          <div className="h-px bg-white/[0.06]" />

          <MenuButton disabled={disabled} onClick={() => close(setOpen, onCreate)}>
            New page
          </MenuButton>

          <MenuButton
            disabled={disabled || !canDelete}
            hint={canDelete ? undefined : 'The dashboard always has at least one page.'}
            tone="danger"
            onClick={() => close(setOpen, onDelete)}
          >
            Delete “{page.name}”
          </MenuButton>

          <div className="h-px bg-white/[0.06]" />

          <ResetEverything
            disabled={disabled}
            onConfirm={() => close(setOpen, onResetEverything)}
          />
        </section>
      )}
    </div>
  )
}

/** Runs the action and gets the menu out of the way of whatever it did. */
function close(setOpen: (open: boolean) => void, action: () => void): void {
  setOpen(false)
  action()
}

/**
 * The page's name, edited in place.
 *
 * A form, so Enter submits — renaming is a one-field job and reaching for a
 * button with the cursor already in the field is friction for nothing. Unlike a
 * panel title, it is not applied on every keystroke: this writes to the server,
 * and a per-character write of a document everyone on the instance shares is not
 * a rename, it is a denial of service.
 */
function RenameField({
  page,
  disabled,
  onRename,
}: {
  page: DashboardPage
  disabled: boolean
  onRename: (name: string) => void
}) {
  const [draft, setDraft] = useState(page.name)
  const unchanged = draft.trim().length === 0 || draft.trim() === page.name

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled && !unchanged) onRename(draft)
      }}
      className="flex flex-col gap-1"
    >
      <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
        <span>Page name</span>
        <input
          type="text"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          className="w-full bg-white/[0.03] border border-white/[0.06] rounded-md px-2 py-1 text-[11px] text-zinc-200 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-[#76B900]/60"
        />
      </label>
      <MenuButton disabled={disabled || unchanged} submit>
        Rename
      </MenuButton>
    </form>
  )
}

/**
 * The reset that takes everything: the stored document is removed, and the
 * default preset — which *is* the absence of the document — comes back.
 *
 * Two clicks, with the second one spelling out what goes. A page delete asks for
 * no confirmation because it takes one page the operator can see; this takes
 * every arrangement on the instance, including colleagues' work.
 */
function ResetEverything({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false)

  if (!asking) {
    return (
      <MenuButton disabled={disabled} tone="danger" onClick={() => setAsking(true)}>
        Reset everything
      </MenuButton>
    )
  }

  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label="Confirm reset">
      <p className="text-[11px] text-zinc-400 leading-snug">
        Delete every page on this dashboard and go back to the default? This cannot be undone.
      </p>
      <div className="flex gap-1.5">
        <MenuButton disabled={disabled} tone="danger" onClick={onConfirm}>
          Reset everything
        </MenuButton>
        <MenuButton onClick={() => setAsking(false)}>Cancel</MenuButton>
      </div>
    </div>
  )
}

function MenuButton({
  children,
  disabled = false,
  submit = false,
  tone = 'normal',
  hint,
  onClick,
}: {
  children: React.ReactNode
  disabled?: boolean
  submit?: boolean
  tone?: 'normal' | 'danger'
  /** Why the button is unavailable, said in the row rather than in a tooltip. */
  hint?: string
  onClick?: () => void
}) {
  return (
    <div className="flex-1">
      <button
        type={submit ? 'submit' : 'button'}
        onClick={onClick}
        disabled={disabled}
        className={`w-full text-left px-2 py-1.5 rounded text-[11px] border transition-colors ${
          disabled
            ? 'border-white/[0.04] text-zinc-600 cursor-not-allowed'
            : tone === 'danger'
              ? 'border-red-500/30 text-red-300 hover:bg-red-500/10'
              : 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100'
        }`}
      >
        {children}
      </button>
      {hint && disabled && <p className="mt-1 px-2 text-[10px] text-zinc-600">{hint}</p>}
    </div>
  )
}
