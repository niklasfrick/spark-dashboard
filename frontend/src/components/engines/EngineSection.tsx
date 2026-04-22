import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { EngineTab } from './EngineTab'
import { EngineCard } from './EngineCard'
import { GlobalEngineTab, GLOBAL_TAB_VALUE } from './GlobalEngineTab'
import { GlobalEngineCard } from './GlobalEngineCard'
import { aggregateEngines } from '@/lib/engineAggregate'
import type { EngineSnapshot } from '@/types/metrics'
import type { InferenceRequest } from '@/types/events'

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
  batchSize: ChartDataPoint[]
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

  const aggregate = useMemo(() => aggregateEngines(engines), [engines])

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

  // Find the engine that matches the active tab, if any.
  const activeEngine = engines.find(
    (e) => `${e.engine_type}-${e.endpoint}` === activeTab,
  )

  const isGlobal = activeTab === GLOBAL_TAB_VALUE
  const headerTitle = isGlobal
    ? 'All Engines'
    : activeEngine?.model?.name ?? 'No Model Loaded'
  const headerDetail = isGlobal
    ? undefined
    : activeEngine?.model
      ? [activeEngine.model.parameter_size, activeEngine.model.quantization]
          .filter(Boolean)
          .join(' ') || undefined
      : undefined

  return (
    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as string)} className="h-full">
      <Card className="bg-[#0d0d10] border-white/[0.04] h-full">
        <CardHeader className="flex flex-row justify-between items-center gap-4 min-w-0">
          <div className="shrink-0">
            <CardTitle className="text-2xl font-bold text-zinc-100 tracking-tight">{headerTitle}</CardTitle>
            {headerDetail && <p className="text-sm text-zinc-500 mt-0.5">{headerDetail}</p>}
          </div>
          <TabsList
            variant="line"
            className="bg-transparent flex-1 min-w-0 justify-end overflow-hidden flex-nowrap"
          >
            <GlobalEngineTab
              runningCount={aggregate.running_count}
              totalCount={aggregate.total_count}
            />
            {engines.map((engine) => (
              <EngineTab
                key={`${engine.engine_type}-${engine.endpoint}`}
                engine={engine}
              />
            ))}
          </TabsList>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 flex flex-col">
          {/* Global aggregate tab content */}
          <TabsContent value={GLOBAL_TAB_VALUE}>
            <GlobalEngineCard snapshot={aggregate} />
          </TabsContent>

          {/* Per-engine tab contents */}
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
                  batchSize: getChartData(`${engineKey}:batchSize`),
                }
              : undefined

            return (
              <TabsContent
                key={engineKey}
                value={engineKey}
              >
                <EngineCard
                  engine={engine}
                  showCharts={showCharts}
                  chartData={chartDataForEngine}
                  requests={requests}
                />
              </TabsContent>
            )
          })}
        </CardContent>
      </Card>
    </Tabs>
  )
}
