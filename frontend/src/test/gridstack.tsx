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
 * The browser project must never load this file; it exists to exercise the
 * real library.
 */

import type { ReactNode } from 'react'

interface GridStackProps {
  options?: unknown
  children?: ReactNode
  className?: string
}

interface GridStackItemProps {
  id: string
  options?: unknown
  children?: ReactNode
}

export function GridStack({ children, className }: GridStackProps) {
  return (
    <div data-testid="grid-stack" className={className}>
      {children}
    </div>
  )
}

export function GridStackItem({ id, children }: GridStackItemProps) {
  return <div data-testid={`grid-stack-item-${id}`}>{children}</div>
}
