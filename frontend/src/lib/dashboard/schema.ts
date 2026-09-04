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
import { readPageSource, type PageSource } from './pageSource'
import { defaultPanelTitle } from './panels'
import { TIME_WINDOW_SECONDS, type TimeWindow } from '@/types/events'

/**
 * The schema version this build reads and writes.
 *
 * Bump it for **every** shape change, additive ones included, and add the
 * migration that goes with it — an additive migration is a no-op, but the bump
 * is what keeps an older build from parsing the document, dropping the field it
 * has never heard of, and saving the loss. There is no down-migration: a
 * document from a newer version falls back to the preset with a banner, which
 * is what makes rolling the dashboard back recoverable.
 *
 * - v2 added the optional per-page `source` (`lib/dashboard/pageSource`).
 */
export const DASHBOARD_SCHEMA_VERSION = 2

/** Time window a panel's chart covers when the operator has not chosen one. */
export const DEFAULT_TIME_WINDOW: TimeWindow = '5m'

/** The whole configuration: a versioned list of pages. */
export interface DashboardDocument {
  version: number
  pages: DashboardPage[]
}

/** One named arrangement of panels, addressable by its own URL. */
export interface DashboardPage {
  /**
   * Stable identifier, used in the page's URL. Independent of the name so a
   * rename does not break a kiosk display's bookmark.
   */
  id: string
  name: string
  /**
   * What the page's following panels show by default. Absent means automatic —
   * the host's own default — which is where every page starts.
   */
  source?: PageSource
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

  return { version: DASHBOARD_SCHEMA_VERSION, pages: withUniqueIds(pages, 'page') }
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
      // Omitted rather than written as a sentinel, so "never configured" stays
      // what absence means everywhere else in the document.
      ...(page.source === undefined
        ? {}
        : {
            source:
              page.source.kind === 'engine'
                ? { kind: 'engine', endpoint: page.source.endpoint }
                : { kind: 'all' },
          }),
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
  })
}

/** What the panel's header reads: the operator's title, or the type's default. */
export function panelTitle(panel: Pick<DashboardPanel, 'type' | 'title'>): string {
  return panel.title ?? defaultPanelTitle(panel.type)
}

function readPage(raw: Record<string, unknown>): DashboardPage {
  const panels = Array.isArray(raw.panels) ? raw.panels.filter(isRecord).map(readPanel) : []
  const source = readPageSource(raw.source)

  return {
    id: readId(raw.id),
    name: readText(raw.name) ?? '',
    ...(source === undefined ? {} : { source }),
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
