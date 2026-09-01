import { useEffect, useRef, useState } from 'react'
import { PANEL_TYPE_IDS, defaultPanelTitle, type PanelType } from '@/lib/dashboard/panels'
import { BarButton } from './BarButton'

/**
 * Every panel type the dashboard can show, as a list to add from.
 *
 * This is where the full vocabulary becomes reachable rather than only
 * preset-placed — including the types this build renders as a placeholder,
 * which are still real panels an operator may want a slot kept for.
 *
 * **Click-to-add, not drag-from-palette.** The chosen panel is placed in the
 * first free slot and dragged into position from there, so nothing has to be
 * aimed at empty space; dragging out of a list is more moving parts and
 * notably worse on touch. The list closes on the way out for the same reason:
 * the operator's next move is on the panel that just landed.
 */
export function PanelPalette({ onAdd }: { onAdd: (type: PanelType) => void }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Click-outside and Escape close it, the way the dashboard's other popover
  // does — a list covering the page is in the way of the drag that follows.
  useEffect(() => {
    if (!open) return

    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
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

  return (
    <div ref={containerRef} className="relative">
      <BarButton expanded={open} onClick={() => setOpen((current) => !current)}>
        Add panel
      </BarButton>

      {open && (
        <section
          aria-label="Panel palette"
          className="absolute right-0 top-full z-20 mt-1 w-56 max-h-[60vh] overflow-y-auto rounded-md border border-white/[0.08] bg-[#0d0d10] p-1 shadow-xl"
        >
          {/* Declaration order is palette order, so related panels sit
              together where an operator goes looking for them. */}
          {PANEL_TYPE_IDS.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => {
                setOpen(false)
                onAdd(type)
              }}
              className="w-full text-left px-2 py-1.5 rounded text-xs text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100 transition-colors"
            >
              {defaultPanelTitle(type)}
            </button>
          ))}
        </section>
      )}
    </div>
  )
}
