import { useCallback, useState } from 'react'
import { useDashboardConfiguration } from './hooks/useDashboardConfiguration'
import { useMetrics } from './hooks/useMetrics'
import { useMetricsIngest } from './hooks/useMetricsIngest'
import { useRoute } from './hooks/useRoute'
import { LogStreamProvider } from './hooks/LogStreamProvider'
import { MetricsStoreProvider } from './hooks/MetricsStoreProvider'
import { AppHeader } from './components/AppHeader'
import { ConfigurationNotices } from './components/ConfigurationNotices'
import { GridPageEditor } from './components/grid/GridPageEditor'
import { PageBar } from './components/pages/PageBar'
import { withPagePanels } from './lib/dashboard/editing'
import type { SaveOutcome } from './lib/dashboard/client'
import type { DashboardDocument, DashboardPage, DashboardPanel } from './lib/dashboard/schema'

/**
 * One dashboard page: the masthead, the configuration banners, and the panels.
 *
 * Snapshots are ingested here and nowhere else — each panel subscribes to its
 * own series through the store, so this shell does not re-render per snapshot
 * however many panels the page holds.
 */
function DashboardPageView({ pageId }: { pageId: string | null }) {
  const { metrics, connectionStatus, isStale } = useMetrics()
  useMetricsIngest(metrics)
  const { document, notices: configurationNotices, readOnly, save, reset } =
    useDashboardConfiguration()
  // The edit session lives in the editor below, but the header has to know about
  // it: switching pages unmounts the session, so the page list holds still for
  // as long as there is unsaved work in it.
  const [editing, setEditing] = useState(false)

  // Null document means the load has not resolved; rendering nothing beats
  // flashing the preset past an operator whose real page is milliseconds away.
  //
  // A null pageId is the root URL, which follows the page list rather than
  // pinning one — see `lib/dashboard/routes`. There is always a first page to
  // follow: a stored document with no pages is not something an operator can be
  // shown, so the loader resolves that to the preset before it reaches here.
  const page = document && (pageId === null ? document.pages[0] : findPage(document, pageId))

  // The whole document is written, not the page: it is one instance-scoped
  // configuration, and a save has to carry the pages the operator was not
  // editing along with the one they were.
  const savePanels = useCallback(
    (panels: DashboardPanel[]) =>
      document && page
        ? save(withPagePanels(document, page.id, panels))
        : Promise.resolve<SaveOutcome['status']>('failed'),
    [document, page, save],
  )

  return (
    <div className="h-dvh flex flex-col bg-[#08080a] overflow-hidden">
      <AppHeader
        status={connectionStatus}
        isStale={isStale}
        pages={
          document && (
            <PageBar
              document={document}
              // The bar highlights the page being viewed; at the root that is
              // whichever one resolved, so the first tab reads as selected
              // rather than none of them.
              activePageId={page?.id ?? pageId ?? ''}
              readOnly={readOnly}
              editing={editing}
              save={save}
              reset={reset}
            />
          )
        }
      />

      <ConfigurationNotices notices={configurationNotices} />

      <main className="flex-1 min-h-0 p-3 lg:p-4 2xl:p-5 min-[1920px]:p-6">
        {page && (
          <GridPageEditor
            key={page.id}
            page={page}
            readOnly={readOnly}
            onSave={savePanels}
            onEditingChange={setEditing}
          />
        )}
        {document && !page && pageId !== null && <MissingPage pageId={pageId} />}
      </main>
    </div>
  )
}

/**
 * What a kiosk URL lands on once the page it names has been deleted. The way
 * out is the root, which follows the page list and so always has something to
 * show.
 */
function MissingPage({ pageId }: { pageId: string }) {
  return (
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
  )
}

function findPage(document: DashboardDocument, pageId: string): DashboardPage | undefined {
  return document.pages.find((candidate) => candidate.id === pageId)
}

/**
 * The store providers sit above the page, so the ring buffers and the one
 * connection per engine's logs survive navigating between pages rather than
 * being rebuilt each time.
 */
function App() {
  const route = useRoute()

  return (
    <MetricsStoreProvider>
      <LogStreamProvider>
        <DashboardPageView pageId={route.kind === 'page' ? route.pageId : null} />
      </LogStreamProvider>
    </MetricsStoreProvider>
  )
}

export default App
