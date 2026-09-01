import { useEffect, useRef, useState, type RefObject } from 'react'

/** Everything a popover needs to open, close, and be dismissed. */
export interface DismissablePopover<T extends HTMLElement> {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  /** Put this on the element that holds the trigger *and* the popover — a
   *  pointer inside it is not "outside". */
  containerRef: RefObject<T | null>
}

/**
 * A popover that closes when the pointer goes down outside it, or on Escape.
 *
 * Both are what a reader expects of anything that covers the page, and getting
 * either wrong strands the operator behind a panel they cannot dismiss — so the
 * dashboard has one implementation rather than one per popover.
 *
 * Nothing is listened for while it is closed: a page of closed popovers costs
 * no document-level handlers at all.
 */
export function useDismissablePopover<T extends HTMLElement>(): DismissablePopover<T> {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<T | null>(null)

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

  return {
    open,
    setOpen,
    toggle: () => setOpen((current) => !current),
    containerRef,
  }
}
