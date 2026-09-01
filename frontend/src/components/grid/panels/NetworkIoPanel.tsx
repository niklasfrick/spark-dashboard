import { useLatestSnapshot, useMetricSeries } from '@/hooks/useMetricsStore'
import { IoPanel } from './IoPanel'
import type { PanelContentProps } from '../panelRegistry'

/** Network receive/transmit rates and their trend. Host-wide. */
export function NetworkIoPanel({ panel }: PanelContentProps) {
  const snapshot = useLatestSnapshot()
  const rx = useMetricSeries('networkRx', panel.window)
  const tx = useMetricSeries('networkTx', panel.window)

  return (
    <IoPanel
      inbound={{
        tag: 'RX',
        label: 'RX',
        color: '#3B82F6',
        rate: snapshot ? snapshot.network.rx_bytes_per_sec : null,
        data: rx,
      }}
      outbound={{
        tag: 'TX',
        label: 'TX',
        color: '#A855F7',
        rate: snapshot ? snapshot.network.tx_bytes_per_sec : null,
        data: tx,
      }}
    />
  )
}
