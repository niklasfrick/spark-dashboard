import React from 'react'
import { Button } from '@/components/ui/button'
import { BarChart3, LayoutDashboard } from 'lucide-react'
import type { ViewMode } from '@/types/events'

interface ViewModeToggleProps {
  mode: ViewMode
  onToggle: () => void
}

export const ViewModeToggle = React.memo(function ViewModeToggle({
  mode,
  onToggle,
}: ViewModeToggleProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="border-zinc-700 min-h-[44px]"
      onClick={onToggle}
    >
      {mode === 'glanceable' ? (
        <>
          <BarChart3 className="size-4 mr-2" />
          Detailed
        </>
      ) : (
        <>
          <LayoutDashboard className="size-4 mr-2" />
          Glanceable
        </>
      )}
    </Button>
  )
})
