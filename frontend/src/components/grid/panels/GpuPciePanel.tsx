import { useMetricSeries } from '@/hooks/useMetricsStore'
import { gpuLabel } from './gpuLabel'
import { GpuPanelNotice, PanelNotice } from './PanelNotice'
import { IoPanel } from './IoPanel'
import { useGpuPanel } from './useGpuPanel'
import type { PanelContentProps } from '../panelRegistry'

/**
 * One GPU's PCIe traffic: receive and transmit rates, and their trend.
 *
 * The same shape as the network panel, because it answers the same question
 * at a different link — under tensor parallelism the cards talk to each other
 * over the bus, and this is where an operator sees whether that link is what
 * the workload is waiting on.
 *
 * On-die accelerators have no PCIe link (NVML answers `NotSupported`, and the
 * backend reports both directions as null together), which the panel says
 * rather than drawing two flat zero lines.
 */
export function GpuPciePanel({ panel }: PanelContentProps) {
  // Two series from one resolution: `useGpuPanelSeries` subscribes to one
  // metric, so the pair is wired here on the same terms — resolved once, and
  // both subscriptions above the unresolved early return.
  const resolution = useGpuPanel(panel)
  const resolved = resolution.status === 'resolved'
  const rx = useMetricSeries(
    resolved ? resolution.seriesFor('gpuPcieRx') : 'gpuPcieRx',
    panel.window,
  )
  const tx = useMetricSeries(
    resolved ? resolution.seriesFor('gpuPcieTx') : 'gpuPcieTx',
    panel.window,
  )
  if (resolution.status !== 'resolved') return <GpuPanelNotice resolution={resolution} />

  const { gpu } = resolution
  if (gpu.pcie_rx_bytes_per_sec === null || gpu.pcie_tx_bytes_per_sec === null) {
    return <PanelNotice>This GPU has no PCIe link to report.</PanelNotice>
  }

  return (
    <IoPanel
      device={gpu.name}
      label={gpuLabel(resolution, 'PCIe')}
      inbound={{
        tag: 'RX',
        label: 'RX',
        color: '#3B82F6',
        rate: gpu.pcie_rx_bytes_per_sec,
        data: rx,
      }}
      outbound={{
        tag: 'TX',
        label: 'TX',
        color: '#A855F7',
        rate: gpu.pcie_tx_bytes_per_sec,
        data: tx,
      }}
    />
  )
}
