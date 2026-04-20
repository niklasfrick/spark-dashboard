import { ReferenceArea } from 'recharts'
import { NVIDIA_THEME } from '@/lib/theme'
import type { InferenceRequest } from '@/types/events'

export function RequestSpan({ request }: { request: InferenceRequest }) {
  return (
    <ReferenceArea
      x1={request.start_ms}
      x2={request.end_ms}
      fill={NVIDIA_THEME.accent}
      fillOpacity={0.15}
    />
  )
}
