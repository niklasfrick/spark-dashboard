/**
 * The shape of the dashboard configuration document, and how it is read and
 * written.
 *
 * One instance-scoped document holds N pages; each page holds panels; each panel
 * carries a type, an optional operator-authored title, its grid geometry, a
 * binding and a time window. The server stores it as opaque bytes and knows none
 * of this — all schema knowledge lives here, deliberately, so the project has
 * one cross-language contract (the metrics wire format) rather than two.
 *
 * **The version ships from day one.** Migration functions are written lazily,
 * because an additive change needs none, but the version field cannot be
 * retrofitted later without sniffing at the document's shape and guessing.
 *
 * Reading is tolerant and never throws: a document that cannot be read at all
 * returns null, and the caller falls back to the default preset with a reason
 * the operator can see. Reading is also **lossy for unknown keys** — anything
 * this build does not recognize is dropped on the next save. That is safe
 * precisely because a build that adds a field bumps the version, and a
 * newer-versioned document is never parsed here.
 */

import { readBinding, type PanelBinding } from './bindings'
import { readGeometry, type PanelGeometry } from './grid'
import { isRecord } from './json'
import { defaultPanelTitle } from './panels'
import { TIME_WINDOW_SECONDS, type TimeWindow } from '@/types/events'

/**
 * The schema version this build reads and writes.
 *
 * Bump it when a change is not additive, and add the migration that goes with
 * it. There is no down-migration: a document from a newer version falls back to
 * the preset with a banner, which is what makes rolling the dashboard back
 * recoverable.
 */
export const DASHBOARD_SCHEMA_VERSION = 1

/** Defaults the exporter uses when the operator has not chosen an index. */
export const DASHBOARD_DEFAULTS = {
  hecIndex: 'metrics',
  hecEventsIndex: 'main',
} as const

/** Time window a panel's chart covers when the operator has not chosen one. */
export const DEFAULT_TIME_WINDOW: TimeWindow = '5m'

/** The whole configuration: a versioned list of pages, plus the optional
 * global export section. The export section is global (host-scoped) rather
 * than per page, which is why it lives beside `pages` instead of inside one. */
export interface DashboardDocument {
  version: number
  pages: DashboardPage[]
  /** Absent until the operator configures Splunk HEC export. Presence = enabled. */
  export?: HecExportConfig
}

/**
 * The `export.hec` section of the document, mirroring the server's view.
 * The token is write-only: the server answers reads with it masked
 * (`…abcd`), and a save that sends an empty token keeps the stored one.
 */
export interface HecExportConfig {
  url: string
  /**
   * What the server last returned: the stored token masked (`…abcd`), or a
   * value the operator typed. Empty means "keep the stored token" on save.
   */
  token: string
  /** Metrics-type index the metric events land in. Default `metrics`. */
  index: string
  /** Conventional index GPU events land in. Default `main`. */
  events_index: string
}

/** The mask the server applies to stored tokens on read. */
export const HEC_TOKEN_MASK_PREFIX = '…'

/** One named arrangement of panels, addressable by its own URL. */
export interface DashboardPage {
  /**
   * Stable identifier, used in the page's URL. Independent of the name so a
   * rename does not break a kiosk display's bookmark.
   */
  id: string
  name: string
  panels: DashboardPanel[]
}

/** One panel on a page. */
export interface DashboardPanel {
  /** Unique within its page. */
  id: string
  /**
   * A `PanelType` when this build implements it. Typed as a plain string
   * because a rolled-back build must still be able to hold a panel it cannot
   * render rather than discard it.
   */
  type: string
  /** Absent when the operator has not renamed the panel. */
  title?: string
  geometry: PanelGeometry
  binding: PanelBinding
  window: TimeWindow
}

/**
 * Reads a document at the current schema version. Null when there is nothing
 * readable here, including when the version is not this build's — deciding what
 * to show instead is the loader's job, because only it knows whether the
 * document came from the future or merely needs migrating.
 */
export function parseDashboardDocument(raw: unknown): DashboardDocument | null {
  if (!isRecord(raw)) return null
  if (raw.version !== DASHBOARD_SCHEMA_VERSION) return null
  if (!Array.isArray(raw.pages)) return null

  const pages = raw.pages.filter(isRecord).map(readPage)
  // A list that held entries and yielded no readable page is corruption. An
  // empty list is not: a configuration can legitimately have no pages, and
  // calling that unreadable would put a "cannot be read" banner in front of an
  // operator who had simply deleted their last one.
  if (pages.length === 0 && raw.pages.length > 0) return null

  const document: DashboardDocument = { version: DASHBOARD_SCHEMA_VERSION, pages: withUniqueIds(pages, 'page') }
  const hecExport = readHecExport(raw.export)
  if (hecExport) document.export = hecExport

  return document
}

/**
 * Writes the document for the server to store.
 *
 * Only known keys are written, and geometry is written in full rather than
 * relying on the grid library's habit of omitting its own defaults — so the file
 * on disk describes itself, and a future migration reading it does not have to
 * know which values were elided.
 */
export function serializeDashboardDocument(document: DashboardDocument): string {
  return JSON.stringify({
    version: DASHBOARD_SCHEMA_VERSION,
    pages: document.pages.map((page) => ({
      id: page.id,
      name: page.name,
      panels: page.panels.map((panel) => ({
        id: panel.id,
        type: panel.type,
        // Omitted rather than written as null, so "never renamed" stays
        // distinguishable from "renamed to nothing".
        ...(panel.title === undefined ? {} : { title: panel.title }),
        geometry: {
          x: panel.geometry.x,
          y: panel.geometry.y,
          w: panel.geometry.w,
          h: panel.geometry.h,
        },
        binding: panel.binding,
        window: panel.window,
      })),
    })),
    // Absence is what disables the export; a save never writes an empty
    // section into existence.
    ...(document.export === undefined
      ? {}
      : {
          export: {
            hec: {
              url: document.export.url,
              token: tokenForSave(document.export.token),
              index: document.export.index,
              events_index: document.export.events_index,
            },
          },
        }),
  })
}

/**
 * The server stores the operator's real token; a masked value is the server's
 * display copy, not data. On save a masked token reverts to empty, which is
 * the server's "keep the stored token" encoding.
 *
 * ponytail: a token the operator literally typed starting with `…` is lost on
 * save; the server's own mask prefix is not a plausible token character.
 */
function tokenForSave(token: string): string {
  return token.startsWith(HEC_TOKEN_MASK_PREFIX) ? '' : token
}

/**
 * Reads the `export.hec` section tolerantly. Absent (or not a record with a
 * string url) means "not configured" — the exporter's off state, which is a
 * normal configuration, not a fault.
 */
function readHecExport(raw: unknown): HecExportConfig | undefined {
  if (!isRecord(raw) || !isRecord(raw.hec)) return undefined
  const hec = raw.hec
  if (typeof hec.url !== 'string') return undefined

  return {
    url: hec.url,
    token: typeof hec.token === 'string' ? hec.token : '',
    index: typeof hec.index === 'string' && hec.index.length > 0 ? hec.index : 'metrics',
    events_index: typeof hec.events_index === 'string' && hec.events_index.length > 0 ? hec.events_index : 'main',
  }
}

/** What the panel's header reads: the operator's title, or the type's default. */
export function panelTitle(panel: Pick<DashboardPanel, 'type' | 'title'>): string {
  return panel.title ?? defaultPanelTitle(panel.type)
}

function readPage(raw: Record<string, unknown>): DashboardPage {
  const panels = Array.isArray(raw.panels) ? raw.panels.filter(isRecord).map(readPanel) : []

  return {
    id: readId(raw.id),
    name: readText(raw.name) ?? '',
    panels: withUniqueIds(panels, 'panel'),
  }
}

function readPanel(raw: Record<string, unknown>): DashboardPanel {
  const title = readText(raw.title)

  return {
    id: readId(raw.id),
    type: readText(raw.type) ?? '',
    ...(title === undefined ? {} : { title }),
    geometry: readGeometry(raw.geometry),
    binding: readBinding(raw.binding),
    window: readWindow(raw.window),
  }
}

/**
 * A trimmed, non-empty string, or undefined. Whitespace-only is treated as
 * absent so a title cleared in the UI reverts to the panel type's default
 * rather than rendering as a blank header.
 */
function readText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Empty marks "no usable id"; `withUniqueIds` fills it from the position. */
function readId(value: unknown): string {
  return readText(value) ?? ''
}

function readWindow(value: unknown): TimeWindow {
  return typeof value === 'string' && Object.hasOwn(TIME_WINDOW_SECONDS, value)
    ? (value as TimeWindow)
    : DEFAULT_TIME_WINDOW
}

/**
 * Gives everything a unique, non-empty id, derived from its position when the
 * document had none or repeated one.
 *
 * Repairing rather than rejecting is the point: an id collision would break the
 * grid's keys and a page's URL, but discarding the offender loses an
 * arrangement the operator built by hand. Pages get a display name here too,
 * for the same reason.
 */
function withUniqueIds<T extends { id: string }>(items: T[], kind: 'page' | 'panel'): T[] {
  const taken = new Set<string>()

  return items.map((item, position) => {
    let id = item.id || `${kind}-${position + 1}`
    for (let suffix = 2; taken.has(id); suffix++) {
      id = `${item.id || `${kind}-${position + 1}`}-${suffix}`
    }
    taken.add(id)

    const named =
      kind === 'page' && 'name' in item && !item.name
        ? { ...item, name: `Page ${position + 1}` }
        : item

    return { ...named, id }
  })
}
