import { TabsTrigger } from '@/components/ui/tabs'
import { engineDisplayName } from '@/lib/format'
import type { EngineSnapshot } from '@/types/metrics'

interface EngineTabProps {
  engine: EngineSnapshot
}

/**
 * Strip the "organization/" prefix from a HuggingFace-style id so only the
 * model name itself shows (e.g. "Qwen/Qwen2.5-7B-Instruct" -> "Qwen2.5-7B-Instruct").
 * No length cap — let CSS handle ellipsis when the tab row is too narrow.
 */
function shortenModelName(name: string): string {
  return name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
}

/** Pull ":port" from an endpoint URL. Returns null if parsing fails. */
function portFromEndpoint(endpoint: string): string | null {
  try {
    const url = new URL(endpoint)
    return url.port ? `:${url.port}` : null
  } catch {
    const match = endpoint.match(/:(\d+)(?:\/|$)/)
    return match ? `:${match[1]}` : null
  }
}

export function EngineTab({ engine }: EngineTabProps) {
  const displayName = engineDisplayName(engine.engine_type)
  const statusLabel = engine.status.type === 'Error'
    ? `Error: ${engine.status.message}`
    : engine.status.type
  const isStopped = engine.status.type === 'Stopped'
  const isDocker = engine.deployment_mode === 'Docker'
  const modeLabel = isDocker ? 'Docker' : 'Direct'

  // Differentiator: model name preferred, endpoint port as fallback.
  const instanceLabel = engine.model?.name
    ? shortenModelName(engine.model.name)
    : portFromEndpoint(engine.endpoint) ?? displayName

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
      className={`flex items-center gap-1.5 px-3 py-1.5 leading-none transition-opacity duration-300 min-w-0 ${
        isStopped ? 'opacity-40' : ''
      } data-[active]:border-b-2 data-[active]:border-[#76B900]`}
      aria-label={`${displayName} ${instanceLabel} · ${modeLabel} - ${statusLabel}`}
    >
      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotColor[engine.status.type]}`} />
      <img src="/icons/vllm.svg" alt="" aria-hidden="true" className="h-3.5 w-auto block shrink-0" />
      {isDocker && (
        <img src="/icons/docker.svg" alt="" aria-hidden="true" className="h-3.5 w-auto block shrink-0" />
      )}
      <span
        className={`text-xs font-semibold tracking-tight leading-none truncate min-w-0 ${
          isStopped ? 'text-zinc-600' : 'text-zinc-200'
        }`}
        title={engine.model?.name ?? engine.endpoint}
      >
        {instanceLabel}
      </span>
      <span className="text-zinc-600 leading-none shrink-0">·</span>
      <span className={`text-[11px] leading-none shrink-0 ${isStopped ? 'text-zinc-600' : 'text-zinc-400'}`}>
        {modeLabel}
      </span>
    </TabsTrigger>
  )
}
