import { describe, it, expect } from 'vitest'
import {
  DASHBOARD_MIGRATION_PATH,
  runMigrations,
  type DashboardMigration,
  type MigrationPath,
} from './migrations'
import { DASHBOARD_SCHEMA_VERSION, parseDashboardDocument } from './schema'

/**
 * One real document in a superseded format, and what it has to become.
 *
 * Every registered migration needs an entry here — the coverage spec below
 * fails otherwise. Adding the first migration means appending a case, not
 * building a harness: paste the document as it was actually written by the
 * older build, and assert the panels the operator should still see.
 */
interface MigrationFixture {
  name: string
  /** The document exactly as the older build persisted it. */
  stored: unknown
  /** The version `stored` declares — the same number as the migration's `from`. */
  from: number
  /** What the migrated document must contain, checked after a full parse. */
  expect: (document: NonNullable<ReturnType<typeof parseDashboardDocument>>) => void
}

const MIGRATION_FIXTURES: MigrationFixture[] = []

/** A stand-in migration, so the runner's chaining is covered before there is a real one. */
function stub(from: number, mark: string): DashboardMigration {
  return {
    from,
    migrate: (document) => ({ ...document, marks: [...asMarks(document.marks), mark] }),
  }
}

function asMarks(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : []
}

function path(migrations: DashboardMigration[], target: number): MigrationPath {
  return { migrations, target }
}

describe('runMigrations against the real migration path', () => {
  it('runs nothing against a document already at the current version', () => {
    const stored = { version: DASHBOARD_SCHEMA_VERSION, pages: [] }
    const outcome = runMigrations(stored, DASHBOARD_SCHEMA_VERSION)

    expect(outcome).toEqual({ status: 'current', document: stored })
  })

  it('has a fixture for every registered migration', () => {
    // Kept in step deliberately: a migration without a real document to prove
    // it against is a migration nobody has run.
    expect(MIGRATION_FIXTURES.map((fixture) => fixture.from).sort()).toEqual(
      DASHBOARD_MIGRATION_PATH.migrations.map((migration) => migration.from).sort(),
    )
  })

  it('targets the version this build reads', () => {
    expect(DASHBOARD_MIGRATION_PATH.target).toBe(DASHBOARD_SCHEMA_VERSION)
  })

  it('leaves no gap in the chain of registered migrations', () => {
    const froms = DASHBOARD_MIGRATION_PATH.migrations.map((migration) => migration.from)
    expect(froms).toEqual([...froms].sort((a, b) => a - b))
    froms.forEach((from, position) => {
      if (position > 0) expect(from).toBe(froms[position - 1] + 1)
    })
  })

  // Empty until the first migration exists; each fixture then becomes a spec.
  for (const fixture of MIGRATION_FIXTURES) {
    it(`migrates ${fixture.name} into a document that still parses`, () => {
      const outcome = runMigrations(fixture.stored, fixture.from)
      expect(outcome.status).toBe('migrated')

      const document = parseDashboardDocument(
        outcome.status === 'migrated' ? outcome.document : null,
      )
      expect(document).not.toBeNull()
      fixture.expect(document!)
    })
  }
})

describe('runMigrations chaining', () => {
  it('applies every step in order and stamps the version it reached', () => {
    const outcome = runMigrations({ version: 1 }, 1, path([stub(1, 'a'), stub(2, 'b')], 3))

    expect(outcome).toEqual({
      status: 'migrated',
      ran: 2,
      document: { version: 3, marks: ['a', 'b'] },
    })
  })

  it("starts from the document's own version rather than the beginning", () => {
    const outcome = runMigrations({ version: 2 }, 2, path([stub(1, 'a'), stub(2, 'b')], 3))

    expect(outcome).toEqual({
      status: 'migrated',
      ran: 1,
      document: { version: 3, marks: ['b'] },
    })
  })

  it('leaves the stored document untouched', () => {
    // A read path that mutated its input would be a step towards writing back
    // on load, which is exactly what must not happen to a shared document.
    const stored = { version: 1, marks: ['original'] }
    runMigrations(stored, 1, path([stub(1, 'a')], 2))

    expect(stored).toEqual({ version: 1, marks: ['original'] })
  })

  it('refuses a version with no migration to run', () => {
    // A document older than the oldest migration cannot be brought forward.
    expect(runMigrations({ version: 0 }, 0, path([stub(1, 'a')], 2))).toEqual({
      status: 'unmigratable',
      from: 0,
    })
  })

  it('refuses a version from the future rather than looping', () => {
    expect(runMigrations({ version: 9 }, 9, path([stub(1, 'a')], 2))).toEqual({
      status: 'unmigratable',
      from: 9,
    })
  })

  it('refuses a chain that stops short of the target', () => {
    // Registering 1→2 while the build reads version 3 is a programming error,
    // and silently handing back a half-migrated document would hide it.
    expect(runMigrations({ version: 1 }, 1, path([stub(1, 'a')], 3))).toEqual({
      status: 'unmigratable',
      from: 1,
    })
  })
})
