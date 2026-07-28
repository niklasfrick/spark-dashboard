import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { EngineTab } from './EngineTab'
import { EngineCard } from './EngineCard'
import { GlobalEngineTab, GLOBAL_TAB_VALUE } from './GlobalEngineTab'
import { GlobalEngineCard } from './GlobalEngineCard'
import { TabRotationControl } from './TabRotationControl'
import { LatencyModeControl } from './LatencyModeControl'
import {
  parseRotationState,
  serializeRotationState,
  type RotationInterval,
} from '@/lib/rotation'
import {
  parseLatencyMode,
  serializeLatencyMode,
  type LatencyMode,
} from '@/lib/latencyMode'
import { aggregateEngines, groupRunningByProvider } from '@/lib/engineAggregate'
import { engineDisplayName, formatGpuIndexes } from '@/lib/format'
import { engineKey, findEngineByKey } from '@/lib/identity'
import { getProviderLogo } from '@/lib/providerLogo'
import { useTabRotation } from '@/hooks/useTabRotation'
import type { EngineSnapshot, EngineType, DeploymentMode } from '@/types/metrics'
import type { InferenceRequest } from '@/types/events'

/** Icon path per engine type. Files ship in `public/icons/`. */
const ENGINE_ICON: Record<EngineType, string> = {
  Vllm: '/icons/vllm.svg',
}

const ROTATION_INTERVAL_STORAGE_KEY = 'spark-dashboard:engine-rotation-interval'
const LATENCY_MODE_STORAGE_KEY = 'spark-dashboard:latency-mode'
const ACTIVE_TAB_STORAGE_KEY = 'spark-dashboard:active-tab'

function EngineChip({ label, iconSrc }: { label: string; iconSrc?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] font-medium leading-none text-zinc-200">
      {iconSrc && (
        <img
          src={iconSrc}
          alt=""
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 object-contain"
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
      )}
      <span>{label}</span>
    </span>
  )
}

function DeploymentChip({ mode }: { mode: DeploymentMode }) {
  if (mode === 'Docker') {
    return <EngineChip label="Docker" iconSrc="/icons/docker.svg" />
  }
  // Native / Direct — no dedicated logo, use a small inline "server" glyph.
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] font-medium leading-none text-zinc-200">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 shrink-0 text-zinc-400"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="3" width="12" height="4" rx="1" />
        <rect x="2" y="9" width="12" height="4" rx="1" />
        <circle cx="4.5" cy="5" r="0.5" fill="currentColor" />
        <circle cx="4.5" cy="11" r="0.5" fill="currentColor" />
      </svg>
      <span>Direct</span>
    </span>
  )
}

interface ChartDataPoint {
  timestamp: number
  value: number
}

interface EngineChartData {
  tps: ChartDataPoint[]
  avgTps: ChartDataPoint[]
  perReqTps: ChartDataPoint[]
  ttft: ChartDataPoint[]
  kv: ChartDataPoint[]
  prefixCacheHit: ChartDataPoint[]
  e2eLatency: ChartDataPoint[]
  promptTps: ChartDataPoint[]
  avgPromptTps: ChartDataPoint[]
  perReqPromptTps: ChartDataPoint[]
  queueTime: ChartDataPoint[]
  interTokenLatency: ChartDataPoint[]
  batchSize: ChartDataPoint[]
  ttftP50: ChartDataPoint[]
  ttftP95: ChartDataPoint[]
  ttftP99: ChartDataPoint[]
  itlP50: ChartDataPoint[]
  itlP95: ChartDataPoint[]
  itlP99: ChartDataPoint[]
  e2eP50: ChartDataPoint[]
  e2eP95: ChartDataPoint[]
  e2eP99: ChartDataPoint[]
  tpot: ChartDataPoint[]
  tpotP50: ChartDataPoint[]
  tpotP95: ChartDataPoint[]
  tpotP99: ChartDataPoint[]
  activeRequests: ChartDataPoint[]
  queuedRequests: ChartDataPoint[]
  totalRequests: ChartDataPoint[]
}

interface EngineSectionProps {
  engines: EngineSnapshot[]
  showCharts?: boolean
  collapseCharts?: boolean
  getChartData?: (metric: string) => ChartDataPoint[]
  requests?: InferenceRequest[]
  /** Number of GPUs in the host snapshot. The per-engine GPU badge renders
   *  only when there are 2+ — on single-GPU hosts the placement is trivial. */
  gpuCount?: number
  /** Notify when the selected engine tab changes; undefined = Global tab.
   *  The log viewer follows this to stream the selected engine's container. */
  onActiveEngineChange?: (endpoint: string | undefined) => void
  /** Notify the hardware dashboard when the selected engine has known GPU placement. */
  onActiveEngineGpuChange?: (gpuIndexes?: number[]) => void
}

export function EngineSection({
  engines,
  showCharts = false,
  collapseCharts = false,
  getChartData,
  requests,
  gpuCount = 0,
  onActiveEngineChange,
  onActiveEngineGpuChange,
}: EngineSectionProps) {
  const [activeTab, setActiveTab] = useState<string>(() => {
    if (typeof window === 'undefined') return GLOBAL_TAB_VALUE
    try {
      return window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY) ?? GLOBAL_TAB_VALUE
    } catch {
      return GLOBAL_TAB_VALUE
    }
  })
  const [rotationEnabledState, setRotationEnabledState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    try {
      return parseRotationState(window.localStorage.getItem(ROTATION_INTERVAL_STORAGE_KEY)).enabled
    } catch {
      return true
    }
  })
  const [rotationInterval, setRotationInterval] = useState<RotationInterval>(() => {
    if (typeof window === 'undefined') return 10000
    try {
      return parseRotationState(window.localStorage.getItem(ROTATION_INTERVAL_STORAGE_KEY)).interval
    } catch {
      return 10000
    }
  })
  const [latencyMode, setLatencyMode] = useState<LatencyMode>(() => {
    if (typeof window === 'undefined') return 'avg'
    try {
      return parseLatencyMode(window.localStorage.getItem(LATENCY_MODE_STORAGE_KEY))
    } catch {
      return 'avg'
    }
  })
  const [focusWithin, setFocusWithin] = useState(false)
  const [userPaused, setUserPaused] = useState(false)

  useEffect(() => {
    if (!userPaused) return
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      if (!target || !target.closest('[data-slot="tabs-list"]')) {
        setUserPaused(false)
        setFocusWithin(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [userPaused])

  const handleTabChange = (v: string) => {
    setActiveTab(v)
    setUserPaused(true)
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, v)
      } catch {
        // ignore storage errors (private mode, quota, etc.)
      }
    }
  }

  const handleRotationEnabledChange = (next: boolean) => {
    setRotationEnabledState(next)
    if (next) {
      setUserPaused(false)
      setFocusWithin(false)
    }
  }

  const handleRotationIntervalChange = (next: RotationInterval) => {
    setRotationInterval(next)
    setUserPaused(false)
    setFocusWithin(false)
  }

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        ROTATION_INTERVAL_STORAGE_KEY,
        serializeRotationState({ enabled: rotationEnabledState, interval: rotationInterval }),
      )
    } catch {
      // ignore storage errors (private mode, quota, etc.)
    }
  }, [rotationEnabledState, rotationInterval])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(LATENCY_MODE_STORAGE_KEY, serializeLatencyMode(latencyMode))
    } catch {
      // ignore storage errors
    }
  }, [latencyMode])

  const aggregate = useMemo(() => aggregateEngines(engines), [engines])
  const providerGroups = useMemo(() => groupRunningByProvider(engines), [engines])

  const showGlobalControls = aggregate.running_count > 1

  const isGlobal = activeTab === GLOBAL_TAB_VALUE
  const activeEngine = findEngineByKey(engines, activeTab)
  const activeEngineGpuIndexesKey = activeEngine?.gpu_indexes?.join(',') ?? ''

  const activeEngineEndpoint = isGlobal ? undefined : activeEngine?.endpoint
  useEffect(() => {
    onActiveEngineChange?.(activeEngineEndpoint)
  }, [activeEngineEndpoint, onActiveEngineChange])

  useEffect(() => {
    if (isGlobal || !onActiveEngineGpuChange) return
    const gpuIndexes = activeEngineGpuIndexesKey
      ? activeEngineGpuIndexesKey.split(',').map(Number)
      : undefined
    onActiveEngineGpuChange(gpuIndexes)
  }, [activeEngineGpuIndexesKey, isGlobal, onActiveEngineGpuChange])

  const tabOrder = useMemo(
    () => [
      ...(showGlobalControls ? [GLOBAL_TAB_VALUE] : []),
      ...engines.map(engineKey),
    ],
    [engines, showGlobalControls],
  )

  // `activeTab` can fall out of step with the engines actually present: it is
  // restored from localStorage before any metrics arrive, and engines come and
  // go at runtime. Both corrections are applied during render rather than from
  // an effect — React discards this render pass and re-runs it, so a tab that
  // does not exist is never committed. Done in an effect it would paint one
  // frame of an empty or wrong tab first.
  if (!showGlobalControls && engines.length > 0) {
    // Single running engine: there is no global tab to sit on.
    const onlyEngineKey = engineKey(engines[0])
    if (activeTab !== onlyEngineKey) setActiveTab(onlyEngineKey)
  } else if (
    engines.length > 0 &&
    activeTab !== GLOBAL_TAB_VALUE &&
    !tabOrder.includes(activeTab)
  ) {
    // The selected engine is gone — fall back to the aggregate tab.
    setActiveTab(GLOBAL_TAB_VALUE)
  }

  // Clearing the persisted tab is a write to an external store, so it stays in
  // an effect. Runs after the correction above has settled.
  useEffect(() => {
    if (engines.length === 0) return
    if (activeTab !== GLOBAL_TAB_VALUE) return
    if (typeof window === 'undefined') return
    try {
      const stored = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY)
      if (stored !== null && stored !== GLOBAL_TAB_VALUE && !tabOrder.includes(stored)) {
        window.localStorage.removeItem(ACTIVE_TAB_STORAGE_KEY)
      }
    } catch {
      // ignore storage errors
    }
  }, [engines.length, activeTab, tabOrder])

  const rotationEnabled =
    rotationEnabledState && !focusWithin && !userPaused && tabOrder.length > 1
  const { cycle, activeIntervalMs } = useTabRotation({
    order: tabOrder,
    activeTab,
    onAdvance: setActiveTab,
    intervalMs: rotationInterval,
    enabled: rotationEnabled,
  })

  // Empty state: no engines detected at all
  if (engines.length === 0) {
    return (
      <Card className="bg-[#0d0d10] border-white/[0.04] h-full">
        <CardHeader>
          <CardTitle className="text-xl font-semibold text-zinc-100">LLM Engines</CardTitle>
        </CardHeader>
        <CardContent className="py-8">
          <p className="text-zinc-100 text-center">No inference engines detected</p>
          <p className="text-zinc-500 text-sm text-center mt-2">
            Start a vLLM inference engine and it will appear here automatically within seconds.
          </p>
        </CardContent>
      </Card>
    )
  }

  const headerTitle = isGlobal
    ? 'All Engines'
    : activeEngine?.model?.name ?? 'No Model Loaded'

  const headerProviderLogo = !isGlobal ? getProviderLogo(activeEngine?.model?.name) : null

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => handleTabChange(v as string)}
    >
      <Card size="sm" className="bg-[#0d0d10] border-white/[0.04] overflow-hidden">
        <CardHeader className="flex flex-row justify-between items-center gap-4 min-w-0 shrink-0">
          <div className="shrink-0 flex items-center gap-4 min-w-0">
            {headerProviderLogo && (
              <div className="shrink-0 h-14 w-14 rounded-xl bg-white p-2 flex items-center justify-center ring-1 ring-white/[0.06]">
                <img
                  src={headerProviderLogo.url}
                  alt={headerProviderLogo.alt}
                  className="h-full w-full object-contain"
                  onError={(e) => {
                    const tile = e.currentTarget.parentElement
                    if (tile) tile.style.display = 'none'
                  }}
                />
              </div>
            )}
            <div className="min-w-0">
              <CardTitle className="text-2xl font-bold text-zinc-100 tracking-tight truncate" title={headerTitle}>
                {headerTitle}
              </CardTitle>
              {isGlobal ? (
                providerGroups.length > 0 && (
                  <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                    {providerGroups.map((g) => (
                      <EngineChip
                        key={g.key}
                        label={`${g.label} (${g.count})`}
                        iconSrc={g.logo?.url}
                      />
                    ))}
                  </div>
                )
              ) : activeEngine ? (
                <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                  <EngineChip
                    label={engineDisplayName(activeEngine.engine_type)}
                    iconSrc={ENGINE_ICON[activeEngine.engine_type]}
                  />
                  <DeploymentChip mode={activeEngine.deployment_mode} />
                  {gpuCount >= 2 &&
                    activeEngine.gpu_indexes &&
                    activeEngine.gpu_indexes.length > 0 && (
                      <EngineChip label={formatGpuIndexes(activeEngine.gpu_indexes)} />
                    )}
                  {activeEngine.model?.parameter_size && (
                    <EngineChip label={activeEngine.model.parameter_size} />
                  )}
                  {activeEngine.model?.precision && (
                    <EngineChip label={activeEngine.model.precision} />
                  )}
                  {activeEngine.model?.quantization && (
                    <EngineChip label={activeEngine.model.quantization} />
                  )}
                  {activeEngine.model?.tensor_type && (
                    <EngineChip label={activeEngine.model.tensor_type} />
                  )}
                  {activeEngine.model?.model_type && (
                    <EngineChip label={activeEngine.model.model_type} />
                  )}
                  {activeEngine.model?.pipeline_tag && (
                    <EngineChip label={activeEngine.model.pipeline_tag} />
                  )}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-1 min-w-0 justify-end">
            <TabsList
              variant="line"
              className="bg-transparent min-w-0 flex-nowrap gap-2 !h-auto overflow-x-auto overflow-y-visible py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              onPointerDown={() => setUserPaused(true)}
              onFocus={() => setFocusWithin(true)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setFocusWithin(false)
                }
              }}
            >
              {showGlobalControls && (
                <>
                  <GlobalEngineTab
                    runningCount={aggregate.running_count}
                    cycle={cycle}
                    intervalMs={activeIntervalMs}
                    showCountdown={isGlobal && rotationEnabled}
                  />
                  {engines.length > 0 && (
                    <span
                      aria-hidden="true"
                      className="self-center h-4 w-px bg-white/[0.06] mx-1 shrink-0"
                    />
                  )}
                </>
              )}
              {engines.map((engine) => {
                const key = engineKey(engine)
                const isActive = key === activeTab
                return (
                  <EngineTab
                    key={key}
                    engine={engine}
                    cycle={cycle}
                    intervalMs={activeIntervalMs}
                    showCountdown={isActive && rotationEnabled}
                  />
                )
              })}
            </TabsList>
            <span
              aria-hidden="true"
              className="self-center h-5 w-px bg-white/[0.08] shrink-0"
            />
            <LatencyModeControl mode={latencyMode} onModeChange={setLatencyMode} />
            {showGlobalControls && (
              <>
                <span
                  aria-hidden="true"
                  className="self-center h-5 w-px bg-white/[0.08] shrink-0"
                />
                <TabRotationControl
                  enabled={rotationEnabledState}
                  interval={rotationInterval}
                  onEnabledChange={handleRotationEnabledChange}
                  onIntervalChange={handleRotationIntervalChange}
                />
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col">
          <TabsContent value={GLOBAL_TAB_VALUE} className="data-[state=active]:flex flex-col">
            <GlobalEngineCard snapshot={aggregate} latencyMode={latencyMode} />
          </TabsContent>

          {engines.map((engine) => {
            const key = engineKey(engine)

            const chartDataForEngine: EngineChartData | undefined = getChartData
              ? {
                  tps: getChartData(`${key}:tps`),
                  avgTps: getChartData(`${key}:avgTps`),
                  perReqTps: getChartData(`${key}:perReqTps`),
                  ttft: getChartData(`${key}:ttft`),
                  kv: getChartData(`${key}:kvCache`),
                  prefixCacheHit: getChartData(`${key}:prefixCacheHit`),
                  e2eLatency: getChartData(`${key}:e2eLatency`),
                  promptTps: getChartData(`${key}:promptTps`),
                  avgPromptTps: getChartData(`${key}:avgPromptTps`),
                  perReqPromptTps: getChartData(`${key}:perReqPromptTps`),
                  queueTime: getChartData(`${key}:queueTime`),
                  interTokenLatency: getChartData(`${key}:interTokenLatency`),
                  batchSize: getChartData(`${key}:batchSize`),
                  ttftP50: getChartData(`${key}:ttftP50`),
                  ttftP95: getChartData(`${key}:ttftP95`),
                  ttftP99: getChartData(`${key}:ttftP99`),
                  itlP50: getChartData(`${key}:itlP50`),
                  itlP95: getChartData(`${key}:itlP95`),
                  itlP99: getChartData(`${key}:itlP99`),
                  e2eP50: getChartData(`${key}:e2eP50`),
                  e2eP95: getChartData(`${key}:e2eP95`),
                  e2eP99: getChartData(`${key}:e2eP99`),
                  tpot: getChartData(`${key}:tpot`),
                  tpotP50: getChartData(`${key}:tpotP50`),
                  tpotP95: getChartData(`${key}:tpotP95`),
                  tpotP99: getChartData(`${key}:tpotP99`),
                  activeRequests: getChartData(`${key}:activeRequests`),
                  queuedRequests: getChartData(`${key}:queuedRequests`),
                  totalRequests: getChartData(`${key}:totalRequests`),
                }
              : undefined

            return (
              <TabsContent
                key={key}
                value={key}
                className="data-[state=active]:flex flex-col"
              >
                <EngineCard
                  engine={engine}
                  showCharts={showCharts}
                  collapseCharts={collapseCharts}
                  chartData={chartDataForEngine}
                  requests={requests}
                  latencyMode={latencyMode}
                />
              </TabsContent>
            )
          })}
        </CardContent>
      </Card>
    </Tabs>
  )
}
