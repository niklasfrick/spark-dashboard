import { MetricCard } from '@/components/MetricCard'
import { ArcGauge } from '@/components/gauges/ArcGauge'
import { StackedBar } from '@/components/StackedBar'
import { BigNumberSparkline } from '@/components/charts/BigNumberSparkline'
import { formatBytes, formatTps } from '@/lib/format'
import { THRESHOLDS } from '@/lib/theme'
import type { MetricsSnapshot } from '@/types/metrics'

interface GlanceableViewProps {
  metrics: MetricsSnapshot | null
  tpsSparkline: number[]
}

export function GlanceableView({ metrics, tpsSparkline }: GlanceableViewProps) {
  if (!metrics) return null

  // Memory calculations
  const usedPercent = metrics.memory.total_bytes > 0
    ? (metrics.memory.used_bytes / metrics.memory.total_bytes) * 100
    : 0
  const gpuUsed = metrics.memory.gpu_estimated_bytes ?? 0
  const cpuUsed = Math.max(0, metrics.memory.used_bytes - gpuUsed)
  const cached = Math.min(metrics.memory.cached_bytes, metrics.memory.available_bytes)
  const free = Math.max(0, metrics.memory.available_bytes - cached)

  const memorySegments = [
    { value: gpuUsed, total: metrics.memory.total_bytes, color: 'bg-[#76B900]', label: `GPU (est.): ${formatBytes(gpuUsed)}` },
    { value: cpuUsed, total: metrics.memory.total_bytes, color: 'bg-blue-500', label: `CPU: ${formatBytes(cpuUsed)}` },
    { value: cached, total: metrics.memory.total_bytes, color: 'bg-zinc-500', label: `Cached: ${formatBytes(cached)}` },
    { value: free, total: metrics.memory.total_bytes, color: 'bg-zinc-700', label: `Free: ${formatBytes(free)}` },
  ]

  // Active engine: first engine with Running status
  const activeEngine = metrics.engines.find(e => e.status.type === 'Running')
  const engineTitle = activeEngine
    ? activeEngine.model?.name ?? 'Unknown Model'
    : 'No Engine'
  const engineSubtitle = activeEngine?.model
    ? [activeEngine.model.parameter_size, activeEngine.model.quantization].filter(Boolean).join(' ')
    : undefined
  const tps = activeEngine?.metrics?.tokens_per_sec ?? null

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {/* GPU Utilization */}
      <MetricCard title="GPU Utilization" subtitle={metrics.gpu.name ?? undefined}>
        <div className="flex justify-center p-4">
          <ArcGauge
            value={metrics.gpu.utilization_percent ?? 0}
            label="GPU Util"
            unit="%"
            size={160}
          />
        </div>
      </MetricCard>

      {/* CPU Usage */}
      <MetricCard title="CPU Usage" subtitle={metrics.cpu.name ?? undefined}>
        <div className="flex justify-center p-4">
          <ArcGauge
            value={metrics.cpu.aggregate_percent}
            label="CPU"
            unit="%"
            thresholds={THRESHOLDS.cpuUsage}
            size={160}
          />
        </div>
      </MetricCard>

      {/* Memory Usage */}
      <MetricCard title="Memory">
        <div className="flex justify-center p-4">
          <ArcGauge
            value={usedPercent}
            label="Memory"
            unit="%"
            thresholds={THRESHOLDS.memoryUsage}
            size={160}
          />
        </div>
        <StackedBar segments={memorySegments} />
      </MetricCard>

      {/* Active Engine - spans full width when present */}
      <MetricCard
        title={engineTitle}
        subtitle={engineSubtitle}
      >
        <div className="p-4">
          <BigNumberSparkline
            value={tps}
            history={tpsSparkline}
            unit="tok/s"
            format={formatTps}
          />
          {activeEngine && (
            <div className="mt-3">
              <span className={`text-sm font-semibold ${
                activeEngine.status.type === 'Running' ? 'text-[#76B900]' : 'text-zinc-400'
              }`}>
                {activeEngine.status.type}
              </span>
            </div>
          )}
          {!activeEngine && (
            <p className="text-sm text-zinc-500 mt-2">No inference engine detected</p>
          )}
        </div>
      </MetricCard>
    </div>
  )
}
