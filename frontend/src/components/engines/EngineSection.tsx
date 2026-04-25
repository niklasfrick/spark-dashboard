import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { EngineTab } from './EngineTab'
import { EngineCard } from './EngineCard'
import { GlobalEngineTab, GLOBAL_TAB_VALUE } from './GlobalEngineTab'
import { GlobalEngineCard } from './GlobalEngineCard'
import {
  TabRotationControl,
  parseRotationState,
  serializeRotationState,
  type RotationInterval,
} from './TabRotationControl'
import {
  LatencyModeControl,
  parseLatencyMode,
  serializeLatencyMode,
  type LatencyMode,
} from './LatencyModeControl'
import { aggregateEngines, groupRunningByProvider } from '@/lib/engineAggregate'
import { engineDisplayName } from '@/lib/format'
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
}

interface EngineSectionProps {
  engines: EngineSnapshot[]
  showCharts?: boolean
  getChartData?: (metric: string) => ChartDataPoint[]
  requests?: InferenceRequest[]
}

export function EngineSection({
  engines,
  showCharts = false,
  getChartData,
  requests,
}: EngineSectionProps) {
  const [activeTab, setActiveTab] = useState<string>(GLOBAL_TAB_VALUE)
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

  useEffect(() => {
    if (showGlobalControls || engines.length === 0) return
    const onlyEngineKey = `${engines[0].engine_type}-${engines[0].endpoint}`
    if (activeTab !== onlyEngineKey) {
      setActiveTab(onlyEngineKey)
    }
  }, [showGlobalControls, activeTab, engines])

  const tabOrder = useMemo(
    () => [
      ...(showGlobalControls ? [GLOBAL_TAB_VALUE] : []),
      ...engines.map((e) => `${e.engine_type}-${e.endpoint}`),
    ],
    [engines, showGlobalControls],
  )

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

  const activeEngine = engines.find(
    (e) => `${e.engine_type}-${e.endpoint}` === activeTab,
  )

  const isGlobal = activeTab === GLOBAL_TAB_VALUE
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
                  {activeEngine.model?.parameter_size && (
                    <EngineChip label={activeEngine.model.parameter_size} />
                  )}
                  {activeEngine.model?.quantization && (
                    <EngineChip label={activeEngine.model.quantization} />
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
                const engineKey = `${engine.engine_type}-${engine.endpoint}`
                const isActive = engineKey === activeTab
                return (
                  <EngineTab
                    key={engineKey}
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
            const engineKey = `${engine.engine_type}-${engine.endpoint}`

            const chartDataForEngine: EngineChartData | undefined = getChartData
              ? {
                  tps: getChartData(`${engineKey}:tps`),
                  avgTps: getChartData(`${engineKey}:avgTps`),
                  perReqTps: getChartData(`${engineKey}:perReqTps`),
                  ttft: getChartData(`${engineKey}:ttft`),
                  kv: getChartData(`${engineKey}:kvCache`),
                  e2eLatency: getChartData(`${engineKey}:e2eLatency`),
                  promptTps: getChartData(`${engineKey}:promptTps`),
                  avgPromptTps: getChartData(`${engineKey}:avgPromptTps`),
                  perReqPromptTps: getChartData(`${engineKey}:perReqPromptTps`),
                  queueTime: getChartData(`${engineKey}:queueTime`),
                  interTokenLatency: getChartData(`${engineKey}:interTokenLatency`),
                  batchSize: getChartData(`${engineKey}:batchSize`),
                  ttftP50: getChartData(`${engineKey}:ttftP50`),
                  ttftP95: getChartData(`${engineKey}:ttftP95`),
                  ttftP99: getChartData(`${engineKey}:ttftP99`),
                  itlP50: getChartData(`${engineKey}:itlP50`),
                  itlP95: getChartData(`${engineKey}:itlP95`),
                  itlP99: getChartData(`${engineKey}:itlP99`),
                  e2eP50: getChartData(`${engineKey}:e2eP50`),
                  e2eP95: getChartData(`${engineKey}:e2eP95`),
                  e2eP99: getChartData(`${engineKey}:e2eP99`),
                }
              : undefined

            return (
              <TabsContent
                key={engineKey}
                value={engineKey}
                className="data-[state=active]:flex flex-col"
              >
                <EngineCard
                  engine={engine}
                  showCharts={showCharts}
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
