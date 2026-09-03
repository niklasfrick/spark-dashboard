import { createContext, useContext, useEffect } from 'react'

/**
 * How a panel's content tells its frame which hardware it ended up reading.
 *
 * The device belongs on the title row — "GPU Utilization · NVIDIA GB10", the
 * way the fixed dashboard's cards read — but only the content knows what it
 * resolved to, and only the frame owns that row. So the content reports it
 * upward rather than the frame reaching down: a frame that resolved bindings
 * itself would have to subscribe to every snapshot, which would re-render all
 * of the grid on every tick and undo the point of the per-panel store.
 *
 * Absent outside a frame — a panel rendered on its own in a spec reports to
 * nobody and renders exactly the same.
 */
export const PanelDeviceContext = createContext<((device: string | null) => void) | null>(null)

/**
 * Names the hardware this panel is reading, for its frame's title row.
 *
 * Call it above any early return, like every other hook here: a panel that has
 * not resolved its binding yet still has to call it, with nothing to report.
 * Clearing on unmount is what keeps a panel that stops resolving — a GPU pulled
 * from the host — from leaving a stale device name in its own title.
 */
export function usePanelDevice(device: string | null | undefined): void {
  const report = useContext(PanelDeviceContext)

  useEffect(() => {
    if (!report) return
    report(device ?? null)
    return () => report(null)
  }, [report, device])
}
