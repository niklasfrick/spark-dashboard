import { TabsTrigger } from '@/components/ui/tabs'

export const GLOBAL_TAB_VALUE = '__global'

interface GlobalEngineTabProps {
  runningCount: number
  /** Rotation cycle counter — used as `key` to restart the CSS countdown animation. */
  cycle?: number
  /** Current cycle duration in ms. `0` disables the countdown animation. */
  intervalMs?: number
  /** `true` when this tab is active AND rotation is enabled. */
  showCountdown?: boolean
}

export function GlobalEngineTab({
  runningCount,
  cycle,
  intervalMs,
  showCountdown,
}: GlobalEngineTabProps) {
  const showBar = showCountdown === true && typeof intervalMs === 'number' && intervalMs > 0

  return (
    <TabsTrigger
      value={GLOBAL_TAB_VALUE}
      className="relative flex items-center gap-2.5 px-6 py-4 leading-none rounded-md transition-colors duration-200 !flex-initial hover:bg-white/[0.03] data-[active]:bg-white/[0.05] data-[active]:border-b-2 data-[active]:border-[#76B900]"
      aria-label={`All engines aggregate view · ${runningCount} engines running`}
    >
      <span className="text-xs font-semibold tracking-tight leading-none text-zinc-200">
        All
      </span>
      {showBar && (
        <span
          key={cycle}
          aria-hidden="true"
          className="tab-rotation-bar absolute left-0 bottom-0 h-0.5 w-full bg-[#76B900]/70"
          style={{ ['--rotation-duration' as string]: `${intervalMs}ms` }}
        />
      )}
    </TabsTrigger>
  )
}
