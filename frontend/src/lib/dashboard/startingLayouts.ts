/**
 * The built-in arrangements a new page can start from, instead of starting
 * empty.
 *
 * A **starting layout** is not the preset. The preset is the one document
 * rendered when nothing is stored; a starting layout is never rendered unless an
 * operator asks for it from New page, and asking for it only ever *adds* a page.
 * It changes no existing page and never the preset, so a fresh install still
 * opens on the preset's one page.
 *
 * Its panels are **copied** into the new page when it is made. From then on the
 * page is the operator's like any other — rearranged, renamed or deleted — and
 * nothing ties it back to the layout it started from, so a later build that
 * revised a layout would leave the pages already made from it alone.
 *
 * Every panel follows, for the same reason the preset's do: nothing here names a
 * GPU index or an endpoint, so there is nothing to be wrong about the host the
 * page is made on. And none places a log panel — the log viewer is off by
 * default, and an operator who turned it on places one where they want it.
 */

import { FOLLOW } from './bindings'
import type { PanelGeometry } from './grid'
import type { PanelType } from './panels'
import { DEFAULT_TIME_WINDOW, type DashboardPanel } from './schema'

/** A built-in arrangement a new page can start from. */
export interface StartingLayout {
  /**
   * What the page made from it is called — and, with " layout" after it, what
   * New page offers it as. Taken as it stands when it is free; numbered when a
   * page already has it, since two identically named tabs cannot be told apart.
   */
  readonly name: string
  /**
   * A fresh copy of its panels. Fresh on every call for the preset's reason: a
   * shared array would let editing one page made from it reach the next.
   */
  panels(): DashboardPanel[]
}

/**
 * The fixed dashboard that 0.14 replaced, as a page of panels.
 *
 * It follows that dashboard's reading order as closely as a twelve-column grid
 * and its row cap allow: the engine's identity across the top, then the engine
 * metrics in the order its cards ran, then the GPU row, then the host row. The
 * preset deliberately is *not* this arrangement (see `preset.ts`), which is why
 * it is something an operator asks for rather than something they are given.
 */
export const LEGACY_LAYOUT: StartingLayout = {
  name: 'Legacy',
  panels: () => [
    // ── Which engine this is ──────────────────────────────────────────────
    // The old dashboard's engine header, now its own panel. One row is all
    // the full width needs: the model, its status, and the chips in one line.
    panel('engine', 'engine-status', { x: 0, y: 0, w: 12, h: 1 }),

    // ── What it is serving ────────────────────────────────────────────────
    // The old engine cards' left-to-right order, each a two-column panel as
    // they were one-sixth-width cards. Cache and speculative decoding were one
    // card and are two panels now, so they share that card's column: cache on
    // top with the room for its values, speculative decoding under it with the
    // one row that its usual state — not enabled — needs.
    panel('prefill', 'engine-prefill-throughput', { x: 0, y: 1, w: 2, h: 3 }),
    panel('decode', 'engine-decode-throughput', { x: 2, y: 1, w: 2, h: 3 }),
    panel('latency', 'engine-latency', { x: 4, y: 1, w: 2, h: 3 }),
    panel('goodput', 'engine-slo-goodput', { x: 6, y: 1, w: 2, h: 3 }),
    panel('requests', 'engine-requests', { x: 8, y: 1, w: 2, h: 3 }),
    panel('cache', 'engine-cache', { x: 10, y: 1, w: 2, h: 2 }),
    panel('spec-decode', 'engine-spec-decode', { x: 10, y: 3, w: 2, h: 1 }),

    // ── What the GPU is doing ─────────────────────────────────────────────
    // The old hardware grid's first row, in its order.
    panel('gpu-util', 'gpu-utilization', { x: 0, y: 4, w: 3, h: 2 }),
    panel('gpu-temp', 'gpu-temperature', { x: 3, y: 4, w: 3, h: 2 }),
    panel('gpu-power', 'gpu-power', { x: 6, y: 4, w: 3, h: 2 }),
    panel('gpu-clock', 'gpu-clock', { x: 9, y: 4, w: 3, h: 2 }),

    // ── What else the host is up to ───────────────────────────────────────
    // The old second row. Its CPU card carried the core heatmap; that is a
    // panel of its own now, so it sits beside CPU utilization and the three
    // after it narrow to fit.
    panel('cpu', 'cpu-utilization', { x: 0, y: 6, w: 3, h: 2 }),
    panel('cpu-cores', 'cpu-cores', { x: 3, y: 6, w: 3, h: 2 }),
    panel('memory', 'memory', { x: 6, y: 6, w: 2, h: 2 }),
    panel('disk', 'disk-io', { x: 8, y: 6, w: 2, h: 2 }),
    panel('network', 'network-io', { x: 10, y: 6, w: 2, h: 2 }),
  ],
}

/** Every starting layout, in the order New page offers them. */
export const STARTING_LAYOUTS: readonly StartingLayout[] = [LEGACY_LAYOUT]

/**
 * One panel of a starting layout. No title, as in the preset: the panel type's
 * own default is used, so renaming a default later reaches pages that never
 * customized it.
 */
function panel(id: string, type: PanelType, geometry: PanelGeometry): DashboardPanel {
  return { id, type, geometry, binding: FOLLOW, window: DEFAULT_TIME_WINDOW }
}
