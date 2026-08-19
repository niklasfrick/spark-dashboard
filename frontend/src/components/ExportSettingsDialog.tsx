import { useState } from 'react'
import { useExportStatus } from '@/hooks/useExportStatus'
import {
  lastErrorCopy,
  statusLight,
  statusLineCopy,
  testExportConnection,
  testOutcomeCopy,
  type TestResult,
} from '@/lib/export'
import {
  DASHBOARD_DEFAULTS,
  HEC_TOKEN_MASK_PREFIX,
  type DashboardDocument,
} from '@/lib/dashboard/schema'
import type { SaveOutcome } from '@/lib/dashboard/client'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const LIGHT_CLASS = {
  green: 'bg-green-500',
  red: 'bg-red-500',
  gray: 'bg-zinc-600',
} as const

const FIELD_CLASS =
  'w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-white/25'

interface ExportSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The loaded configuration document; null until the first read resolves. */
  document: DashboardDocument | null
  /** Storage that cannot be written at all (the instance banner already says so). */
  readOnly: boolean
  save: (document: DashboardDocument) => Promise<SaveOutcome['status']>
}

/**
 * The first global settings surface: the gear icon in the header opens this
 * dialog. SLO settings deliberately stay where they are (per engine/model,
 * browser-local); this is the host-scoped surface (ADR 0001).
 */
export function ExportSettingsDialog({
  open,
  onOpenChange,
  document,
  readOnly,
  save,
}: ExportSettingsDialogProps) {
  // Form state, seeded from the document on mount. Base UI unmounts the
  // popup while the dialog is closed, so each open re-seeds; an in-flight
  // edit session keeps its own values because the state lives here.
  const [url, setUrl] = useState(document?.export?.url ?? '')
  const [token, setToken] = useState(document?.export?.token ?? '')
  const [index, setIndex] = useState<string>(document?.export?.index ?? DASHBOARD_DEFAULTS.hecIndex)
  const [eventsIndex, setEventsIndex] = useState<string>(
    document?.export?.events_index ?? DASHBOARD_DEFAULTS.hecEventsIndex,
  )

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')

  // Poll only while open (ADR 0001): 5 s in the dialog, 10 s for the header dot.
  const status = useExportStatus(5_000, open)
  const light = statusLight(status)
  // This line reports the *background exporter's* last error, which is
  // always about the saved document's target — never the unsaved form
  // fields. Naming the live `url` here would blame today's typing for
  // yesterday's failure.
  const error = lastErrorCopy(status?.last_error ?? null, document?.export?.url ?? undefined)
  const configured = document?.export !== undefined
  const urlEmpty = url.trim().length === 0
  const maskedToken = token.startsWith(HEC_TOKEN_MASK_PREFIX)

  const handleSave = async () => {
    if (!document || urlEmpty) return
    setSaveState('saving')
    const outcome = await save({
      ...document,
      export: {
        url: url.trim(),
        // Empty means "keep the stored token"; the serializer also reverts a
        // masked value to empty, so a save never re-sends what it cannot see.
        token: maskedToken ? '' : token,
        index: index.trim() || DASHBOARD_DEFAULTS.hecIndex,
        events_index: eventsIndex.trim() || DASHBOARD_DEFAULTS.hecEventsIndex,
      },
    })
    setSaveState(outcome === 'saved' ? 'saved' : 'failed')
  }

  const handleDisable = async () => {
    if (!document) return
    setSaveState('saving')
    // Presence of the section is what enables the export; removing it —
    // including the token — is how the operator switches it off.
    const rest: DashboardDocument = { version: document.version, pages: document.pages }
    const outcome = await save(rest)
    setSaveState(outcome === 'saved' ? 'saved' : 'failed')
  }

  const handleTest = async () => {
    setTesting(true)
    // Test the dialog's current fields, not the last-saved document — an
    // operator must be able to try a URL/token/index before committing it.
    const result = await testExportConnection({
      url: url.trim(),
      token,
      index: index.trim(),
    })
    setTestResult(result)
    setTesting(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Global settings for this dashboard instance.</DialogDescription>
        </DialogHeader>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">Export to Splunk</h2>
            <span className="flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full ${LIGHT_CLASS[light]}`} />
              <span className="text-xs text-zinc-400">{statusLineCopy(status)}</span>
            </span>
          </div>
          {error && <p className="text-xs text-yellow-400">{error}</p>}

          <div className="grid gap-3">
            <label className="grid gap-1 text-xs text-zinc-400">
              HEC URL
              <input
                className={FIELD_CLASS}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://splunk.example.com:8088/services/collector"
                spellCheck={false}
              />
            </label>
            <label className="grid gap-1 text-xs text-zinc-400">
              HEC token
              <input
                className={FIELD_CLASS}
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={maskedToken ? token : 'paste the HEC token'}
                spellCheck={false}
              />
              {maskedToken && (
                <span className="text-[11px] text-zinc-500">
                  A token is stored; leave empty to keep it.
                </span>
              )}
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-xs text-zinc-400">
                Metrics index
                <input
                  className={FIELD_CLASS}
                  value={index}
                  onChange={(e) => setIndex(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className="grid gap-1 text-xs text-zinc-400">
                Events index
                <input
                  className={FIELD_CLASS}
                  value={eventsIndex}
                  onChange={(e) => setEventsIndex(e.target.value)}
                  spellCheck={false}
                />
              </label>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleTest} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saveState === 'saving' || urlEmpty || readOnly}
            >
              {saveState === 'saved' ? 'Saved' : 'Save'}
            </Button>
            {configured && (
              <Button variant="outline" size="sm" onClick={handleDisable} disabled={readOnly}>
                Disable export
              </Button>
            )}
            {saveState === 'failed' && (
              <span className="text-xs text-red-400">Save failed</span>
            )}
          </div>

          {testResult && (
            <p className="text-xs text-zinc-300">
              {testOutcomeCopy(testResult.outcome, { url: url.trim() || undefined, index: testResult.index })}
            </p>
          )}

          <details className="text-xs text-zinc-500">
            <summary className="cursor-pointer text-zinc-400">Splunk-side prerequisites</summary>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4">
              <li>Splunk ≥ 8.0 (on-prem or Cloud).</li>
              <li>The metrics index is a metrics-type index.</li>
              <li>
                A dedicated HEC token whose <code>indexes</code> allowlist includes the
                configured index.
              </li>
            </ol>
          </details>
        </section>
      </DialogContent>
    </Dialog>
  )
}
