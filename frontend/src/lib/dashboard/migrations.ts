/**
 * Bringing an older document forward to the version this build reads.
 *
 * An additive change gets an identity migration — the bump is what protects the
 * new field from an older build's lossy save, and the migration merely walks
 * the version forward. Rewriting waits for a change that is not additive; this
 * is the lazy half of the versioning decision. The eager half is that the
 * version field ships from day one, because it cannot be added later without
 * sniffing at a document's shape and guessing what wrote it.
 *
 * Two rules hold whatever the migrations end up doing:
 *
 * - **Migrations run in memory only.** Nothing here writes, and the loader does
 *   not write back either. The configuration is shared by everyone who opens the
 *   instance, so a viewer who merely upgraded and opened the page must not
 *   rewrite the document and lock out colleagues still on the previous build.
 *   A migrated document is persisted on the next save the operator asks for.
 * - **No down-migration.** A document from a newer version is refused here and
 *   falls back to the default preset with a banner, which is what makes rolling
 *   the dashboard back a recoverable operation.
 */

import { DASHBOARD_SCHEMA_VERSION } from './schema'
import { isRecord } from './json'

/** One step forward, from `from` to `from + 1`. */
export interface DashboardMigration {
  /** The version this migration reads. */
  from: number
  /**
   * Returns the document one version newer. Must not mutate its argument, and
   * need not set `version` — the runner stamps that.
   */
  migrate: (document: Record<string, unknown>) => Record<string, unknown>
}

/** The migrations available, and the version they lead to. */
export interface MigrationPath {
  /** Ordered by `from`, with no gaps, ending one below `target`. */
  migrations: readonly DashboardMigration[]
  target: number
}

/**
 * v1 → v2: the per-page `source` arrived. Additive — an absent source means
 * automatic, which is exactly what every v1 page was — so nothing is rewritten;
 * the runner stamps the version.
 */
const addPageSource: DashboardMigration = {
  from: 1,
  migrate: (document) => ({ ...document }),
}

/**
 * The real path, targeting the current version.
 *
 * Adding a migration means appending it here, bumping
 * `DASHBOARD_SCHEMA_VERSION`, and adding a fixture to `migrations.test.ts`.
 */
export const DASHBOARD_MIGRATION_PATH: MigrationPath = {
  migrations: [addPageSource],
  target: DASHBOARD_SCHEMA_VERSION,
}

/** What happened when the document was brought forward. */
export type MigrationOutcome =
  /** Already at the target version; nothing ran and nothing changed. */
  | { status: 'current'; document: unknown }
  /**
   * Brought forward in memory. `ran` is how many steps applied. The caller must
   * treat this as read-only state and persist it only on a user-initiated save.
   */
  | { status: 'migrated'; document: unknown; ran: number }
  /**
   * There is no path from that version — older than the oldest migration, newer
   * than this build, or a chain with a hole in it. The caller falls back to the
   * default preset and says so.
   */
  | { status: 'unmigratable'; from: number }

/**
 * Brings `raw` forward from `from` to the path's target.
 *
 * `path` is injectable so the chaining is covered by stand-in migrations rather
 * than waiting for the first real one — the alternative is a runner whose only
 * tested behaviour is doing nothing.
 */
export function runMigrations(
  raw: unknown,
  from: number,
  path: MigrationPath = DASHBOARD_MIGRATION_PATH,
): MigrationOutcome {
  if (from === path.target) return { status: 'current', document: raw }
  if (from > path.target || !isRecord(raw)) return { status: 'unmigratable', from }

  let document = raw
  let version = from
  let ran = 0

  while (version < path.target) {
    const migration = path.migrations.find((candidate) => candidate.from === version)
    // A hole in the chain is a programming error. Handing back a half-migrated
    // document would hide it behind a fallback that looks like data corruption.
    if (!migration) return { status: 'unmigratable', from }

    version += 1
    document = { ...migration.migrate(document), version }
    ran += 1
  }

  return { status: 'migrated', document, ran }
}
