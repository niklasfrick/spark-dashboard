import type { ReactNode } from 'react'

/**
 * The body of a panel whose content is a list of rows rather than a chart — the
 * GPU events, the inference requests.
 *
 * These panels size themselves by scrolling rather than by dropping content the
 * way the gauge panels do. There is no reduced rendering of an event that is
 * still an event, and the newest are at the top, so even a 1×1 cell shows the
 * one that matters.
 *
 * The list is named, because a panel's rows are a second landmark inside a
 * frame that already has one — the frame's title says which GPU, this says what
 * the rows are.
 */
export function PanelList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul
      aria-label={label}
      className="h-full min-h-0 min-w-0 overflow-y-auto flex flex-col gap-0.5 pr-0.5"
    >
      {children}
    </ul>
  )
}
