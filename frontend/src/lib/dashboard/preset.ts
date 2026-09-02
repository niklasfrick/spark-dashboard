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
 * **The arrangement is three bands, one question each**: what the machine is
 * serving, what the GPU is doing, and what else the host is up to. Within a band the leading
 * panel is double width, because a default that gives ten metrics the same area
 * says none of them matters more than the others — which is the flaw this rework
 * exists to fix. It is deliberately not a reproduction of the fixed dashboard it
 * replaced: that layout was eight equal hardware cards under an engine block,
 * and reproducing it would have carried its lack of hierarchy across.
 *
 * The engine band leads, because what the machine is serving is what an
 * operator opens the dashboard to see; the GPU band under it is the answer to
 * "why". The cost is accepted deliberately: on a host running no engines the
 * first band is three placeholders, and the hardware an operator can still use
 * starts one band down.
 *
 * **One page**, not several. A second preset page could only be another
 * arrangement of the same panels — the pages worth having are the ones an
 * operator builds for their own workload, and a page they did not ask for is a
 * tab they have to delete. The one page tiles the grid exactly, so the desktop
 * layout fills the viewport without scrolling.
 *
 * **No log panel**, on any page. The log viewer is off by default in every
 * deployment, so a preset that placed one would open a stock install on a panel
 * explaining that a feature is unavailable. Logs are placed by the operator who
 * turned them on.
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
          // ── What it is serving ──────────────────────────────────────────
          // Decode throughput is the number an operator quotes for an
          // inference host, so it leads the page at double width; latency and
          // the request queue are what explain it when it drops.
          panel('decode', 'engine-decode-throughput', { x: 0, y: 0, w: 6, h: 3 }),
          panel('latency', 'engine-latency', { x: 6, y: 0, w: 3, h: 3 }),
          panel('requests', 'engine-requests', { x: 9, y: 0, w: 3, h: 3 }),

          // ── What the GPU is doing ───────────────────────────────────────
          // Utilization leads its band at double width — it is the panel that
          // resolves on every host the dashboard runs on. Power and
          // temperature flank it: the two numbers that say whether the GPU can
          // keep doing it.
          panel('gpu-util', 'gpu-utilization', { x: 0, y: 3, w: 6, h: 3 }),
          panel('gpu-power', 'gpu-power', { x: 6, y: 3, w: 3, h: 3 }),
          panel('gpu-temp', 'gpu-temperature', { x: 9, y: 3, w: 3, h: 3 }),

          // ── What else the host is up to ─────────────────────────────────
          // Equal and short: these are glanced at to rule something out, not
          // read. GPU clock belongs to this tier of interest too, but it is a
          // consequence of the power and thermal state directly above rather
          // than a signal of its own, so the default leaves it to the palette.
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
