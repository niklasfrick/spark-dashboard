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
  const isDocker = engine.deployment_mode === 'Docker'
  const modeLabel = isDocker ? 'Docker' : 'Direct'

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
      className={`flex items-center gap-1.5 px-3 py-1.5 leading-none transition-opacity duration-300 ${
        isStopped ? 'opacity-40' : ''
      } data-[active]:border-b-2 data-[active]:border-[#76B900]`}
      aria-label={`${displayName} · ${modeLabel} - ${statusLabel}`}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${dotColor[engine.status.type]}`} />
      <img src="/icons/vllm.svg" alt="" aria-hidden="true" className="h-3.5 w-auto block" />
      {isDocker && (
        <img src="/icons/docker.svg" alt="" aria-hidden="true" className="h-3.5 w-auto block" />
      )}
      <span className={`text-xs font-semibold tracking-tight leading-none ${isStopped ? 'text-zinc-600' : 'text-zinc-200'}`}>
        {displayName}
      </span>
      <span className="text-zinc-600 leading-none">·</span>
      <span className={`text-[11px] leading-none ${isStopped ? 'text-zinc-600' : 'text-zinc-400'}`}>
        {modeLabel}
      </span>
    </TabsTrigger>
  )
}
