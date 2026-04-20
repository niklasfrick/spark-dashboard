import { useState } from 'react'
import type { ViewMode } from '../types/events'

export function useViewMode() {
  const [mode, setMode] = useState<ViewMode>('detailed')
  const toggle = () =>
    setMode((m) => (m === 'glanceable' ? 'detailed' : 'glanceable'))
  return { mode, toggle }
}
