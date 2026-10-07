import { useEffect, useState } from 'react'
import { fetchExportStatus, type ExportStatus } from '@/lib/export'

/**
 * Polls `GET /api/export-status` every `intervalMs` while `active` is true.
 *
 * The polling cadence is the caller's choice, per ADR 0001: the settings
 * dialog polls at 5 s while open, the header dot at 10 s for as long as the
 * app is open. Nothing polls while `active` is false — a closed dialog is not
 * talking to the server.
 */
export function useExportStatus(intervalMs: number, active: boolean): ExportStatus | null {
  const [status, setStatus] = useState<ExportStatus | null>(null)

  useEffect(() => {
    if (!active) return
    let live = true

    const poll = () => {
      void fetchExportStatus().then((next) => {
        if (live) setStatus(next)
      })
    }
    poll()
    const timer = setInterval(poll, intervalMs)

    return () => {
      live = false
      clearInterval(timer)
    }
  }, [intervalMs, active])

  return status
}
