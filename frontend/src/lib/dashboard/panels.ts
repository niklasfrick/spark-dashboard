/**
 * Every panel the dashboard can put on a page, and what each one binds to.
 *
 * The granularity is deliberate: one panel per metric rather than a handful of
 * fixed composite cards, so an operator watching a training run can give GPU
 * temperature and power the whole screen and drop the network and disk panels
 * entirely. It is the reason the configuration is a versioned schema with a
 * migration obligation — a closed panel set with opaque geometry was considered
 * and rejected.
 *
 * **The ids are persisted.** They appear verbatim in saved documents, so
 * renaming one is a breaking change that needs a migration, not a refactor.
 * Adding one is additive and needs none.
 */

import type { PanelSize } from './grid'

/** What a panel needs pointed at it before it can show anything. */
export type PanelBindingKind =
  /** One GPU, identified by its integer index. */
  | 'gpu'
  /** One inference engine, identified by its endpoint. */
  | 'engine'
  /** Nothing — the panel covers the whole host, or every engine at once. */
  | 'none'

/** What the dashboard knows about a panel type before any document is read. */
export interface PanelTypeSpec {
  /** What has to be bound for the panel to render data. */
  binds: PanelBindingKind
  /** Title shown when the operator has not renamed the panel. */
  title: string
  /**
   * Size the palette places the panel at, when the standard one is wrong for
   * it. Only a starting point — the operator drags and resizes from there — so
   * a type only declares this when the standard size would land it unreadable.
   */
  size?: PanelSize
  /**
   * Whether the panel's rendering covers the time window it carries. Absent
   * means it does, which is true of every panel that charts a series; a type
   * declares `false` when its window would be a control that changes nothing.
   */
  windowed?: boolean
}

/**
 * What a panel is added at: a quarter of the grid's width and a bit under half
 * its height, so four sit in a row and the page still tiles.
 */
export const DEFAULT_PANEL_SIZE: PanelSize = { w: 3, h: 3 }

/**
 * The vocabulary. Declaration order is palette order, so related panels sit
 * together where an operator goes looking for them.
 */
export const PANEL_TYPES = {
  // ── Per-GPU hardware ────────────────────────────────────────────────────
  'gpu-utilization': { binds: 'gpu', title: 'GPU Utilization' },
  'gpu-temperature': { binds: 'gpu', title: 'GPU Temp' },
  'gpu-power': { binds: 'gpu', title: 'GPU Power' },
  'gpu-clock': { binds: 'gpu', title: 'GPU Clock' },
  'gpu-memory': { binds: 'gpu', title: 'GPU Memory' },
  'gpu-fan': { binds: 'gpu', title: 'GPU Fan' },
  // A discrete list rather than a series — but still windowed, unlike `logs`
  // below: the history store keeps a bounded ring of events and filters it by
  // the window, so choosing 15m over 5m genuinely shows the operator more.
  'gpu-events': { binds: 'gpu', title: 'GPU Events' },

  // ── Host-wide hardware ──────────────────────────────────────────────────
  'cpu-utilization': { binds: 'none', title: 'CPU' },
  'cpu-cores': { binds: 'none', title: 'CPU Cores' },
  // Unified-memory hosts report one pool shared with the GPU, so this is a
  // host-wide panel rather than a per-GPU one.
  memory: { binds: 'none', title: 'Memory' },
  'disk-io': { binds: 'none', title: 'Disk I/O' },
  'network-io': { binds: 'none', title: 'Network' },

  // ── Engines ─────────────────────────────────────────────────────────────
  // The only engine panel that binds to nothing: it is about the host, not
  // about one target.
  'engines-overview': { binds: 'none', title: 'All Engines' },
  'engine-status': { binds: 'engine', title: 'Engine' },
  'engine-prefill-throughput': { binds: 'engine', title: 'Prefill Throughput' },
  'engine-decode-throughput': { binds: 'engine', title: 'Decode Throughput' },
  'engine-latency': { binds: 'engine', title: 'Latency' },
  'engine-slo-goodput': { binds: 'engine', title: 'SLO Goodput' },
  'engine-requests': { binds: 'engine', title: 'Requests' },
  'engine-cache': { binds: 'engine', title: 'Cache' },
  'engine-spec-decode': { binds: 'engine', title: 'Speculative Decoding' },
  // Windowed for the same reason as `gpu-events`, and it needs the window
  // twice over: the requests are filtered by it, and the timeline draws each
  // one against it as the axis it is positioned on.
  'inference-timeline': { binds: 'engine', title: 'Inference Requests' },
  // The log socket addresses an engine by endpoint, so logs bind like any
  // other engine panel instead of being a fixed drawer. A line of container
  // output is long, and a tail has no window to cover.
  logs: { binds: 'engine', title: 'Logs', size: { w: 6, h: 4 }, windowed: false },
} as const satisfies Record<string, PanelTypeSpec>

/** A panel type this build implements. */
export type PanelType = keyof typeof PANEL_TYPES

/** Every panel type, in palette order. */
export const PANEL_TYPE_IDS = Object.keys(PANEL_TYPES) as PanelType[]

/**
 * Whether this build implements the panel type.
 *
 * A saved document can name a type this build has never heard of — a newer
 * version added one, and the dashboard was rolled back. That panel keeps its
 * slot and renders as an unsupported-panel placeholder, because dropping it
 * would silently reflow an arrangement the operator authored.
 */
export function isKnownPanelType(type: string): type is PanelType {
  return Object.hasOwn(PANEL_TYPES, type)
}

/**
 * What the panel binds to. An unimplemented type binds to nothing: there is no
 * data to point at something that cannot be rendered.
 */
export function panelBindingKind(type: string): PanelBindingKind {
  return isKnownPanelType(type) ? PANEL_TYPES[type].binds : 'none'
}

/**
 * The title to show when the operator has not renamed the panel. An
 * unimplemented type falls back to its raw id so the placeholder can name what
 * it could not render.
 */
export function defaultPanelTitle(type: string): string {
  return isKnownPanelType(type) ? PANEL_TYPES[type].title : type
}

/**
 * The cells a newly placed panel takes. Click-to-add puts the panel in the
 * first free slot of this size and the operator moves it from there, so this
 * only has to be a sane starting point rather than the right answer.
 */
export function defaultPanelSize(type: string): PanelSize {
  return (isKnownPanelType(type) ? panelSpec(type).size : undefined) ?? DEFAULT_PANEL_SIZE
}

/**
 * Whether the panel's own time window reaches its rendering — the question the
 * settings ask before offering the operator a window to choose.
 *
 * An unimplemented type answers false: it renders a placeholder, so nothing it
 * carries reaches a chart. Its stored window is left untouched all the same,
 * because the build that understands the type will want it.
 */
export function panelUsesWindow(type: string): boolean {
  return isKnownPanelType(type) && panelSpec(type).windowed !== false
}

/**
 * One type's declaration, read as the interface rather than as its own literal
 * type — which is what makes the optional fields readable on the types that
 * leave them out.
 */
function panelSpec(type: PanelType): PanelTypeSpec {
  return PANEL_TYPES[type]
}
