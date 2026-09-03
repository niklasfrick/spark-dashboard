/**
 * The one shared substitute for the grid library in jsdom (seam 3 of the #70
 * test plan). The vitest unit project aliases `gridstack/dist/react` here, so
 * no spec has to remember to mock it and none can accidentally load the real
 * engine — which measures elements, and jsdom measures every box as 0×0.
 *
 * It renders children in document order and nothing else. Layout — where a
 * panel sits, whether it fits, how columns collapse — is deliberately not
 * simulated: the pure grid module covers the geometry, and the browser project
 * covers the real engine. Direct prior art: the multi-GPU dashboard spec
 * substitutes the chart component for exactly this reason.
 *
 * What it does record is the *contract* with the library — the options it was
 * mounted with and the geometry each item was given — and it lets a spec fire
 * the one callback that carries geometry back (see `gridSubstitute`). That is
 * how a spec drives a rearrangement without a layout engine; whether a real drag
 * produces one is the browser project's question, not this file's.
 *
 * The browser project must never load this file; it exists to exercise the
 * real library.
 */

import { useEffect, type ReactNode } from 'react'
import { recordGrid, recordItem, type GridNode } from './gridSubstitute'

interface GridStackProps {
  options?: Record<string, unknown>
  children?: ReactNode
  className?: string
  onChange?: (event: Event, nodes: GridNode[]) => void
}

interface GridStackItemProps {
  id: string
  options?: unknown
  children?: ReactNode
}

export function GridStack({ children, className, options, onChange }: GridStackProps) {
  useEffect(() => recordGrid({ options, onChange }))

  return (
    <div data-testid="grid-stack" className={className}>
      {children}
    </div>
  )
}

export function GridStackItem({ id, options, children }: GridStackItemProps) {
  useEffect(() => recordItem(id, options))

  return <div data-testid={`grid-stack-item-${id}`}>{children}</div>
}
