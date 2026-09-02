/**
 * The configuration lifecycle: load it once at boot, save it when the operator
 * asks, remove it when they reset, and keep whatever the operator needs telling
 * about.
 *
 * Two rules shape everything here, both from the fact that the configuration is
 * **instance-scoped** — one document shared by everyone who opens the dashboard:
 *
 * - **Nothing is written that the operator did not ask for.** No autosave, and
 *   no write-back of a document that merely needed migrating on load. Otherwise
 *   one upgraded viewer opening the page would rewrite the document and lock out
 *   colleagues still on the previous build.
 * - **Nothing is kept in browser-local storage.** Not as a cache, not as a
 *   fallback. A per-browser copy of a shared document is an invisible second
 *   source of truth, which is worse than the visible failure it would hide.
 *
 * Failures are states, not exceptions: there is always a renderable document,
 * and the notices say why it might not be the stored one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteStoredConfiguration,
  fetchStoredConfiguration,
  saveStoredConfiguration,
  type ResetOutcome,
  type SaveOutcome,
} from '@/lib/dashboard/client'
import { loadDashboardConfiguration, type ConfigurationFallbackReason } from '@/lib/dashboard/load'
import type { MigrationPath } from '@/lib/dashboard/migrations'
import type { ConfigurationNotice } from '@/lib/dashboard/notices'
import { defaultDashboardDocument } from '@/lib/dashboard/preset'
import type { DashboardDocument } from '@/lib/dashboard/schema'

type WriteFailureNotice = 'save-failed' | 'too-large' | 'reset-failed' | null

/**
 * How a save's outcome reads to the operator. Read-only is not here: it is a
 * property of the instance rather than of the attempt, and it has its own
 * standing notice as long as it holds.
 */
const SAVE_FAILURE_NOTICE: Record<SaveOutcome['status'], WriteFailureNotice> = {
  saved: null,
  'read-only': null,
  'too-large': 'too-large',
  failed: 'save-failed',
}

/** The same, for a reset. It is a different sentence because it is a different
 *  thing that did not happen: nothing was removed, rather than nothing stored. */
const RESET_FAILURE_NOTICE: Record<ResetOutcome['status'], WriteFailureNotice> = {
  reset: null,
  'read-only': null,
  failed: 'reset-failed',
}

export interface DashboardConfigurationState {
  /**
   * The configuration to render: the stored document, or the default preset.
   * Null until the first response resolves — rendering the preset in the
   * meantime would flash a layout the operator did not save past them.
   */
  document: DashboardDocument | null
  /** Everything the operator needs telling, most consequential first. */
  notices: ConfigurationNotice[]
  /** Whether saving is available at all. False also while the load is in flight. */
  readOnly: boolean
  /**
   * Stores `document`, replacing what the server had. Returns how it went so an
   * edit session can stay open on a failure rather than discarding work the
   * server never accepted.
   */
  save: (document: DashboardDocument) => Promise<SaveOutcome['status']>
  /**
   * Removes the stored document, putting every page back to the default preset.
   * Destructive and unrecoverable, so the caller confirms first.
   */
  reset: () => Promise<ResetOutcome['status']>
}

/**
 * `path` exists for the same reason the loader takes one: the migrating branch
 * is covered by stand-ins rather than waiting for the first real migration. It
 * is read once, when the configuration is loaded — this is a boot-time concern,
 * and latching it means a caller passing an inline object cannot set off a
 * reload on every render.
 */
export function useDashboardConfiguration(path?: MigrationPath): DashboardConfigurationState {
  const [document, setDocument] = useState<DashboardDocument | null>(null)
  const [fallback, setFallback] = useState<ConfigurationFallbackReason | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [writeFailure, setWriteFailure] = useState<WriteFailureNotice>(null)
  const pathRef = useRef(path)

  useEffect(() => {
    let live = true

    void (async () => {
      const stored = await fetchStoredConfiguration()
      if (!live) return

      setReadOnly(stored.readOnly)
      // A server that was never reached is a different problem from a document
      // that could not be read, and the operator's next move differs: check that
      // the dashboard is up, versus look at what is on disk.
      setUnavailable(stored.status === 'unavailable')

      // Anything that is not a document reads as "nothing stored", which
      // resolves to the preset. Whether that is a fault is decided above.
      const loaded = loadDashboardConfiguration(
        stored.status === 'stored' ? stored.body : null,
        pathRef.current,
      )
      setDocument(loaded.document)
      setFallback(stored.status === 'unreadable' ? { kind: 'unreadable' } : loaded.fallback)
    })()

    return () => {
      live = false
    }
  }, [])

  const save = useCallback(
    async (next: DashboardDocument): Promise<SaveOutcome['status']> => {
      // Storage that cannot be written is a permanent condition the operator
      // already has a banner for; a request would only fail the same way.
      if (readOnly) return 'read-only'

      const outcome = await saveStoredConfiguration(next)
      setReadOnly(outcome.readOnly)
      setWriteFailure(SAVE_FAILURE_NOTICE[outcome.status])

      if (outcome.status === 'saved') {
        // What was stored is now what this build wrote, so any complaint about
        // the previous document — unreadable, from a newer build, unreachable —
        // describes something that no longer exists.
        setDocument(next)
        setFallback(null)
        setUnavailable(false)
      }

      return outcome.status
    },
    [readOnly],
  )

  const reset = useCallback(async (): Promise<ResetOutcome['status']> => {
    if (readOnly) return 'read-only'

    const outcome = await deleteStoredConfiguration()
    setReadOnly(outcome.readOnly)
    setWriteFailure(RESET_FAILURE_NOTICE[outcome.status])

    if (outcome.status === 'reset') {
      // The preset is held rather than re-fetched: it is exactly what a read of
      // the now-absent document would resolve to, and going back to the server
      // for an answer already known is a round trip the operator waits through.
      setDocument(defaultDashboardDocument())
      // Every complaint about the stored document described one that no longer
      // exists — including one written by a build this cannot read, which is
      // what makes a reset the way out of a rollback.
      setFallback(null)
      setUnavailable(false)
    }

    return outcome.status
  }, [readOnly])

  const notices = useMemo((): ConfigurationNotice[] => {
    const list: ConfigurationNotice[] = []
    if (fallback) list.push(fallback)
    if (unavailable) list.push({ kind: 'unavailable' })
    if (readOnly) list.push({ kind: 'read-only' })
    if (writeFailure) list.push({ kind: writeFailure })
    return list
  }, [fallback, unavailable, readOnly, writeFailure])

  return { document, notices, readOnly, save, reset }
}
