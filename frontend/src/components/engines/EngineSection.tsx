import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { EngineTab } from './EngineTab'
import { EngineCard } from './EngineCard'
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
  // Empty state: no engines detected
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

  // Tabbed engine view
  const defaultTab = `${engines[0].engine_type}-${engines[0].endpoint}`

  // Use the first running engine's model name as the big title
  const activeEngine = engines.find(e => e.status.type === 'Running') ?? engines[0]
  const modelName = activeEngine?.model?.name ?? 'No Model Loaded'
  const modelDetail = activeEngine?.model
    ? [activeEngine.model.parameter_size, activeEngine.model.quantization].filter(Boolean).join(' ')
    : undefined

  return (
    <Tabs defaultValue={defaultTab} className="h-full">
      <Card className="bg-[#0d0d10] border-white/[0.04] h-full">
        <CardHeader className="flex flex-row justify-between items-center">
          <div>
            <CardTitle className="text-2xl font-bold text-zinc-100 tracking-tight">{modelName}</CardTitle>
            {modelDetail && <p className="text-sm text-zinc-500 mt-0.5">{modelDetail}</p>}
          </div>
          <TabsList variant="line" className="bg-transparent">
            {engines.map((engine) => (
              <EngineTab
                key={`${engine.engine_type}-${engine.endpoint}`}
                engine={engine}
              />
            ))}
          </TabsList>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 flex flex-col">
          {engines.map((engine) => {
            const engineKey = `${engine.engine_type}-${engine.endpoint}`

            // Build sparkline and chart data from history hooks
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
