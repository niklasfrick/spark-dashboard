import { TabsTrigger } from '@/components/ui/tabs'
import { engineDisplayName } from '@/lib/format'
import type { EngineSnapshot } from '@/types/metrics'

interface EngineTabProps {
  engine: EngineSnapshot
}

export function EngineTab({ engine }: EngineTabProps) {
  const displayName = engineDisplayName(engine.engine_type)
  const statusLabel = engine.status.type === 'Error'
    ? `Error: ${engine.status.message}`
    : engine.status.type
  const isStopped = engine.status.type === 'Stopped'

  // Status dot color per UI-SPEC color table
  const dotColor: Record<string, string> = {
    Running: 'bg-green-500',
    Loading: 'bg-yellow-500',
    Stopped: 'bg-red-500',
    Error: 'bg-red-500',
  }

  return (
    <TabsTrigger
      value={`${engine.engine_type}-${engine.endpoint}`}
      className={`flex items-center gap-2 px-3 py-1.5 text-xs transition-opacity duration-300 ${
        isStopped ? 'opacity-40 text-zinc-600' : 'text-zinc-500 data-[active]:text-zinc-200'
      } data-[active]:border-b-2 data-[active]:border-[#76B900]`}
      aria-label={`${displayName} - ${statusLabel}`}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${dotColor[engine.status.type]}`} />
      {displayName}
    </TabsTrigger>
  )
}
