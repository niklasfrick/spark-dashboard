import { useLatestSnapshot, useMetricSeries } from '@/hooks/useMetricsStore'
import { IoPanel } from './IoPanel'
import type { PanelContentProps } from '../panelRegistry'

/** Disk read/write rates and their trend. Host-wide. */
export function DiskIoPanel({ panel }: PanelContentProps) {
  const snapshot = useLatestSnapshot()
  const read = useMetricSeries('diskRead', panel.window)
  const write = useMetricSeries('diskWrite', panel.window)

  return (
    <IoPanel
      device={snapshot?.disk.name}
      inbound={{
        tag: 'R',
        label: 'Read',
        color: '#76B900',
        rate: snapshot ? snapshot.disk.read_bytes_per_sec : null,
        data: read,
      }}
      outbound={{
        tag: 'W',
        label: 'Write',
        color: '#F59E0B',
        rate: snapshot ? snapshot.disk.write_bytes_per_sec : null,
        data: write,
      }}
    />
  )
}
