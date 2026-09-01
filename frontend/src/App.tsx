import { useCallback, useMemo, useState } from 'react'
import { useDashboardConfiguration } from './hooks/useDashboardConfiguration'
import { useMetrics } from './hooks/useMetrics'
import { useMetricsHistory } from './hooks/useMetricsHistory'
import { useMetricsIngest } from './hooks/useMetricsIngest'
import { useRoute } from './hooks/useRoute'
import { MetricsStoreProvider } from './hooks/MetricsStoreProvider'
import { AppHeader } from './components/AppHeader'
import { ConfigurationNotices } from './components/ConfigurationNotices'
import { Dashboard } from './components/views/Dashboard'
import { GridPage } from './components/grid/GridPage'
import { LogViewer } from './components/LogViewer'
import type { GpuEvent, InferenceRequest } from './types/events'

function AppContent() {
  const { metrics, connectionStatus, isStale } = useMetrics()
  // The configuration is loaded and saved from here, at the root, because it is
  // one document for the whole dashboard. Nothing renders from it yet — the
  // panel grid that will is #79 — but the operator is told now when it could not
  // be loaded or cannot be saved, rather than after a layout silently reverts.
  const { notices: configurationNotices } = useDashboardConfiguration()
  const [consoleExpanded, setConsoleExpanded] = useState(false)
  // Endpoint of the engine tab selected in the engine section (null = Global
  // tab). The log viewer follows it so logs stay in sync with the selection.
  const [selectedEngineEndpoint, setSelectedEngineEndpoint] = useState<string | null>(null)
  const handleActiveEngineChange = useCallback((endpoint: string | undefined) => {
    setSelectedEngineEndpoint(endpoint ?? null)
  }, [])

  const history = useMetricsHistory(metrics)

  const { getEvents, getRequests } = history

  const events = useMemo((): GpuEvent[] =>
    getEvents().map((e) => ({
      timestamp_ms: e.timestamp_ms,
      gpu_index: e.gpu_index,
      event_type: e.event_type as GpuEvent['event_type'],
      detail: e.detail,
    })),
    [getEvents],
  )

  const requests = useMemo((): InferenceRequest[] =>
    getRequests().map((r) => ({
      start_ms: r.start_ms,
      end_ms: r.end_ms,
      tps: r.tokens_per_sec,
      ttft_ms: r.ttft_ms,
    })),
    [getRequests],
  )

  return (
    <div className="h-dvh flex flex-col bg-[#08080a] overflow-hidden">
      <AppHeader status={connectionStatus} isStale={isStale} />

      <ConfigurationNotices notices={configurationNotices} />

      <main className={`flex-1 min-h-0 flex flex-col p-3 lg:p-4 2xl:p-5 min-[1920px]:p-6 ${isStale ? 'opacity-50' : ''}`}>
        {!metrics && connectionStatus !== 'connected' && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h2 className="text-xl font-bold text-zinc-50 mb-2">Waiting for metrics</h2>
              <p className="text-zinc-400">
                Connecting to the metrics server at {window.location.origin}. Make sure spark-dashboard is running.
              </p>
            </div>
          </div>
        )}

        <Dashboard
          metrics={metrics}
          history={history}
          events={events}
          requests={requests}
          collapseCharts={consoleExpanded}
          onActiveEngineChange={handleActiveEngineChange}
        />

        <LogViewer
          engines={metrics?.engines ?? []}
          selectedEndpoint={selectedEngineEndpoint}
          onExpandChange={setConsoleExpanded}
        />
      </main>
    </div>
  )
}

// A grid page at its own URL (#79): the same masthead and notices as the root,
// with the panels rendered from the stored configuration. Snapshots are only
// ingested here — each panel subscribes to its own series, so this shell does
// not re-render per snapshot the way the pre-grid dashboard does.
function GridPageContent({ pageId }: { pageId: string }) {
  const { metrics, connectionStatus, isStale } = useMetrics()
  useMetricsIngest(metrics)
  const { document, notices: configurationNotices } = useDashboardConfiguration()

  // Null document means the load has not resolved; rendering nothing beats
  // flashing the preset past an operator whose real page is milliseconds away.
  const page = document?.pages.find((candidate) => candidate.id === pageId)

  return (
    <div className="h-dvh flex flex-col bg-[#08080a] overflow-hidden">
      <AppHeader status={connectionStatus} isStale={isStale} />

      <ConfigurationNotices notices={configurationNotices} />

      <main className="flex-1 min-h-0 p-3 lg:p-4 2xl:p-5 min-[1920px]:p-6">
        {document &&
          (page ? (
            <GridPage key={page.id} page={page} />
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <h2 className="text-xl font-bold text-zinc-50 mb-2">No page at this address</h2>
                <p className="text-zinc-400 mb-4">
                  The dashboard configuration has no page “{pageId}”. It may have been deleted.
                </p>
                <a href="/" className="text-[#76B900] hover:underline">
                  Back to the dashboard
                </a>
              </div>
            </div>
          ))}
      </main>
    </div>
  )
}

// The store provider sits above everything that reads metrics history, so the
// grid pages and the current dashboard share one set of ring buffers. The root
// URL keeps serving the pre-grid dashboard untouched until the #86 cutover;
// grid pages are only reachable at their own URLs.
function App() {
  const route = useRoute()

  return (
    <MetricsStoreProvider>
      {route.kind === 'page' ? <GridPageContent pageId={route.pageId} /> : <AppContent />}
    </MetricsStoreProvider>
  )
}

export default App
