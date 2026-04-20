import { ReferenceLine } from 'recharts'
import { NVIDIA_THEME } from '@/lib/theme'
import type { GpuEvent } from '@/types/events'

export function EventMarker({ event }: { event: GpuEvent }) {
  const stroke =
    event.event_type === 'thermal' || event.event_type === 'xid'
      ? NVIDIA_THEME.critical
      : NVIDIA_THEME.warning

  return (
    <ReferenceLine
      x={event.timestamp_ms}
      stroke={stroke}
      strokeDasharray="4 4"
      strokeWidth={2}
      label={{
        value: event.event_type.charAt(0).toUpperCase(),
        position: 'top',
        fill: '#fafafa',
        fontSize: 10,
      }}
    />
  )
}
