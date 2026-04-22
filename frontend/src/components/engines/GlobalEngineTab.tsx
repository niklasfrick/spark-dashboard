import { TabsTrigger } from '@/components/ui/tabs'

export const GLOBAL_TAB_VALUE = '__global'

interface GlobalEngineTabProps {
  runningCount: number
  totalCount: number
}

export function GlobalEngineTab({ runningCount, totalCount }: GlobalEngineTabProps) {
  const hasRunning = runningCount > 0
  const dotColor = hasRunning ? 'bg-[#76B900]' : 'bg-zinc-600'
  const pulseClass = hasRunning ? 'animate-pulse' : ''

  return (
    <TabsTrigger
      value={GLOBAL_TAB_VALUE}
      className="flex items-center gap-1.5 px-3 py-1.5 leading-none data-[active]:border-b-2 data-[active]:border-[#76B900]"
      aria-label={`Global aggregate · ${runningCount} of ${totalCount} engines running`}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${dotColor} ${pulseClass}`} />
      <span className="text-xs font-semibold tracking-tight leading-none text-zinc-200">
        Global
      </span>
      <span className="text-zinc-600 leading-none">·</span>
      <span className="text-[11px] leading-none text-zinc-400 tabular-nums">
        {runningCount}/{totalCount} running
      </span>
    </TabsTrigger>
  )
}
