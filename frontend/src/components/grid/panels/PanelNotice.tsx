import type { ReactNode } from 'react'
import { engineDescription } from '@/lib/format'
import type { EnginePanelNoticeState } from './useEnginePanel'
import type { GpuPanelResolution } from './useGpuPanel'

/**
 * A panel's stand-in content when there is nothing to render yet — the same
 * quiet styling as the frame's own placeholders, so every empty state on the
 * grid reads the same way.
 */
export function PanelNotice({ children }: { children: ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-center">
      <p className="text-xs text-zinc-500">{children}</p>
    </div>
  )
}

/**
 * What an engine panel says instead of data. Silent substitution is prohibited
 * (see `lib/dashboard/bindings.ts`), so each way of having no target names
 * itself — an operator who changed an engine's port sees which panels now point
 * at nothing, and a panel never fills the gap with another engine's numbers.
 */
export function EnginePanelNotice({ resolution }: { resolution: EnginePanelNoticeState }) {
  switch (resolution.status) {
    case 'waiting':
      return <PanelNotice>Waiting for metrics</PanelNotice>
    case 'starting':
      return <PanelNotice>{engineDescription(resolution.engine)} has no metrics yet.</PanelNotice>
    case 'offline':
      return (
        <PanelNotice>
          {engineDescription(resolution.engine)} {resolution.detail}
        </PanelNotice>
      )
    case 'missing':
      return <PanelNotice>No engine at {resolution.requested} — repoint this panel.</PanelNotice>
    case 'unselected':
      return <PanelNotice>No inference engine running.</PanelNotice>
    case 'unreadable':
      return <PanelNotice>This panel’s pinned engine could not be read — repoint it.</PanelNotice>
  }
}

/**
 * What a GPU panel says instead of data, on the same terms as the engine
 * notices above.
 */
export function GpuPanelNotice({
  resolution,
}: {
  resolution: Exclude<GpuPanelResolution, { status: 'resolved' }>
}) {
  switch (resolution.status) {
    case 'waiting':
      return <PanelNotice>Waiting for metrics</PanelNotice>
    case 'missing':
      return <PanelNotice>{resolution.requested} is not on this host.</PanelNotice>
    case 'unselected':
      return <PanelNotice>No GPU on this host.</PanelNotice>
    case 'unreadable':
      return <PanelNotice>This panel’s pinned GPU could not be read — repoint it.</PanelNotice>
  }
}
