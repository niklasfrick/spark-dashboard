/**
 * Turning whatever the server had into a document the dashboard can render.
 *
 * This is the only entry point that boot needs, and it **never throws and never
 * returns nothing**. Every failure resolves to the default preset plus a reason
 * the UI renders as a banner, because a working dashboard with an explanation
 * beats a blank screen with a console error — and because the operator has to
 * know their layout is not the one being shown.
 *
 * Two things this does not do, both deliberately:
 *
 * - It does not write. A document that needed migrating is migrated in memory
 *   and reported as such; persisting it waits for a save the operator asked for.
 * - It does not consider browser-local storage, here or as a fallback. An
 *   invisible second source of truth for a configuration that is shared by
 *   everyone on the instance is worse than a visible failure.
 */

import { isRecord } from './json'
import { runMigrations, type MigrationPath } from './migrations'
import { defaultDashboardDocument } from './preset'
import { DASHBOARD_SCHEMA_VERSION, parseDashboardDocument, type DashboardDocument } from './schema'

/** Why the stored document is not the one being rendered. */
export type ConfigurationFallbackReason =
  /**
   * Written by a newer build. There is no down-migration, so this is what makes
   * rolling the dashboard back recoverable instead of fatal.
   */
  | { kind: 'newer-version'; documentVersion: number; supportedVersion: number }
  /** Too old to bring forward — no migration path reaches this build. */
  | { kind: 'unsupported-version'; documentVersion: number; supportedVersion: number }
  /** Not readable as a dashboard document at all. */
  | { kind: 'unreadable' }

/** The configuration to render, and what the operator needs telling about it. */
export interface LoadedConfiguration {
  /** Always renderable: the stored document, or the default preset. */
  document: DashboardDocument
  /** True when `document` is the preset rather than what was stored. */
  isDefault: boolean
  /**
   * Null when the stored document loaded, and when there was nothing stored —
   * a fresh install is not a fault and gets no banner.
   */
  fallback: ConfigurationFallbackReason | null
  /**
   * True when migrations ran. The caller must not persist the result: writing
   * back on load would let one upgraded viewer lock out everyone still on the
   * previous build.
   */
  migrated: boolean
}

/**
 * Reads the stored document.
 *
 * `stored` is the raw response body, or null/undefined when the server reported
 * that nothing has been stored. `path` is injectable so the migrating branch is
 * covered with a stand-in rather than waiting for the first real migration.
 */
export function loadDashboardConfiguration(
  stored: string | null | undefined,
  path?: MigrationPath,
): LoadedConfiguration {
  if (stored === null || stored === undefined) return fresh()

  const raw = tryParseJson(stored)
  if (raw === FAILED) return fallback({ kind: 'unreadable' })

  const version = documentVersion(raw)
  if (version === null) return fallback({ kind: 'unreadable' })

  if (version > DASHBOARD_SCHEMA_VERSION) {
    return fallback({
      kind: 'newer-version',
      documentVersion: version,
      supportedVersion: DASHBOARD_SCHEMA_VERSION,
    })
  }

  const outcome = runMigrations(raw, version, path)
  if (outcome.status === 'unmigratable') {
    return fallback({
      kind: 'unsupported-version',
      documentVersion: version,
      supportedVersion: DASHBOARD_SCHEMA_VERSION,
    })
  }

  const document = parseDashboardDocument(outcome.document)
  if (!document) return fallback({ kind: 'unreadable' })

  // A document with no pages has nothing to render, which is the same position a
  // fresh install is in — so it gets the preset, and no banner, because nothing
  // failed and there is no layout to have lost.
  if (document.pages.length === 0) return fresh()

  return { document, isDefault: false, fallback: null, migrated: outcome.status === 'migrated' }
}

/** Nothing stored: the preset, and nothing to tell the operator. */
function fresh(): LoadedConfiguration {
  return { document: defaultDashboardDocument(), isDefault: true, fallback: null, migrated: false }
}

function fallback(reason: ConfigurationFallbackReason): LoadedConfiguration {
  return { document: defaultDashboardDocument(), isDefault: true, fallback: reason, migrated: false }
}

/** Sentinel for JSON that would not parse, so `null` stays a legitimate value. */
const FAILED = Symbol('failed')

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return FAILED
  }
}

/**
 * The version the document declares, or null when it declares none. A document
 * without it cannot be placed at all — which is why the field ships from the
 * first release rather than being inferred later from the document's shape.
 */
function documentVersion(raw: unknown): number | null {
  if (!isRecord(raw)) return null
  return typeof raw.version === 'number' && Number.isInteger(raw.version) ? raw.version : null
}
