/**
 * The dashboard an operator gets before configuring anything.
 *
 * It is a **static document**, not a layout generated from the host it lands on.
 * Every panel binds with the `follow` sentinel, which resolves to the page-level
 * selection, so the same document is right on a one-GPU laptop and on a four-GPU
 * server — the alternative would be runtime generation that needs testing across
 * every GPU and engine permutation.
 *
 * "Nothing configured" and "reset" are the same state: the document does not
 * exist on the server, and this is what renders instead.
 *
 * The arrangement below is a working default, not the final design. The preset
 * redesign — including the second page for logs and the cutover from the current
 * fixed layout — is its own change (#86). What is settled here is the shape: one
 * page that tiles the grid exactly, so the desktop layout fits the viewport.
 */

import { FOLLOW } from './bindings'
import type { PanelGeometry } from './grid'
import type { PanelType } from './panels'
import {
  DASHBOARD_SCHEMA_VERSION,
  DEFAULT_TIME_WINDOW,
  type DashboardDocument,
  type DashboardPanel,
} from './schema'

/**
 * A fresh copy of the default preset.
 *
 * Fresh on every call, deliberately: edit mode operates on this document when
 * nothing is saved, so a shared instance would let one session's dragging leak
 * into the next reset.
 */
export function defaultDashboardDocument(): DashboardDocument {
  return {
    version: DASHBOARD_SCHEMA_VERSION,
    pages: [
      {
        id: 'overview',
        name: 'Overview',
        panels: [
          // Engines across the top — the numbers an operator watches while a
          // model is serving. They degrade to a placeholder on a host running
          // no engines, leaving the hardware rows below still useful.
          panel('decode', 'engine-decode-throughput', { x: 0, y: 0, w: 4, h: 3 }),
          panel('latency', 'engine-latency', { x: 4, y: 0, w: 4, h: 3 }),
          panel('requests', 'engine-requests', { x: 8, y: 0, w: 4, h: 3 }),

          // The GPU band, following the page's GPU selection.
          panel('gpu-util', 'gpu-utilization', { x: 0, y: 3, w: 3, h: 3 }),
          panel('gpu-temp', 'gpu-temperature', { x: 3, y: 3, w: 3, h: 3 }),
          panel('gpu-power', 'gpu-power', { x: 6, y: 3, w: 3, h: 3 }),
          panel('gpu-clock', 'gpu-clock', { x: 9, y: 3, w: 3, h: 3 }),

          // Host-wide hardware, shorter because it is glanced at rather than read.
          panel('cpu', 'cpu-utilization', { x: 0, y: 6, w: 3, h: 2 }),
          panel('memory', 'memory', { x: 3, y: 6, w: 3, h: 2 }),
          panel('disk', 'disk-io', { x: 6, y: 6, w: 3, h: 2 }),
          panel('network', 'network-io', { x: 9, y: 6, w: 3, h: 2 }),
        ],
      },
    ],
  }
}

/**
 * One preset panel. No title — the panel type's own default is used, so
 * renaming a default later reaches operators who never customized it.
 */
function panel(id: string, type: PanelType, geometry: PanelGeometry): DashboardPanel {
  return { id, type, geometry, binding: FOLLOW, window: DEFAULT_TIME_WINDOW }
}
