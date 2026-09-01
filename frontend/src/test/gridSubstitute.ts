/**
 * What the jsdom grid substitute saw, and what a spec can tell it back.
 *
 * Separate from the substitute's components so that file exports components and
 * nothing else — see `gridstack.tsx` for what is and is not simulated there.
 */

/** As much of a gridstack node as anything here cares about. */
export interface GridNode {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** The props the substitute's grid was last rendered with. */
export interface MountedGrid {
  options?: Record<string, unknown>
  onChange?: (event: Event, nodes: GridNode[]) => void
}

let mounted: MountedGrid = {}
const geometry = new Map<string, unknown>()

/** @internal — the substitute's own bookkeeping. */
export function recordGrid(grid: MountedGrid): void {
  mounted = grid
}

/** @internal — the substitute's own bookkeeping. */
export function recordItem(id: string, options: unknown): void {
  geometry.set(id, options)
}

export const gridSubstitute = {
  /** The options the grid is currently mounted with. */
  options(): Record<string, unknown> {
    return mounted.options ?? {}
  },

  /** Whether an edit session has wired itself up — nothing can move without it. */
  acceptsLayoutChanges(): boolean {
    return mounted.onChange !== undefined
  },

  /** The geometry each item was last rendered with, by panel id. */
  geometry(): Map<string, unknown> {
    return new Map(geometry)
  },

  /**
   * Report that the engine moved panels, the way a finished drag or resize
   * does. A no-op when nothing is listening, which is the state of every page
   * that is not being edited.
   */
  moved(nodes: GridNode[]): void {
    mounted.onChange?.(new Event('change'), nodes)
  },

  reset(): void {
    mounted = {}
    geometry.clear()
  },
}
