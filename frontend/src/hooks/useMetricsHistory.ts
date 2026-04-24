import { useRef, useState, useCallback, useEffect } from 'react'
import { CircularBuffer } from '../lib/circular-buffer'
import type { MetricsSnapshot, GpuEventData, InferenceRequestData } from '../types/metrics'

interface DataPoint {
  timestamp: number
  value: number
}

const BUFFER_CAPACITY = 900 // 15 minutes at 1 sample/sec
const EVENT_BUFFER_CAPACITY = 100
const REQUEST_BUFFER_CAPACITY = 50

type MetricKey =
  | 'gpuUtil'
  | 'gpuTemp'
  | 'gpuPower'
  | 'gpuClockGraphics'
  | 'cpuAggregate'
  | 'memoryUsedPercent'
  | 'diskRead'
  | 'diskWrite'
  | 'networkRx'
  | 'networkTx'

const SYSTEM_METRIC_KEYS: MetricKey[] = [
  'gpuUtil',
  'gpuTemp',
  'gpuPower',
  'gpuClockGraphics',
  'cpuAggregate',
  'memoryUsedPercent',
  'diskRead',
  'diskWrite',
  'networkRx',
  'networkTx',
]

function createBuffers(): Record<MetricKey, CircularBuffer<DataPoint>> {
  const buffers = {} as Record<MetricKey, CircularBuffer<DataPoint>>
  for (const key of SYSTEM_METRIC_KEYS) {
    buffers[key] = new CircularBuffer<DataPoint>(BUFFER_CAPACITY)
  }
  return buffers
}

function extractValue(metrics: MetricsSnapshot, key: MetricKey): number | null {
  switch (key) {
    case 'gpuUtil':
      return metrics.gpu.utilization_percent
    case 'gpuTemp':
      return metrics.gpu.temperature_celsius
    case 'gpuPower':
      return metrics.gpu.power_watts
    case 'gpuClockGraphics':
      return metrics.gpu.clock_graphics_mhz
    case 'cpuAggregate':
      return metrics.cpu.aggregate_percent
    case 'memoryUsedPercent':
      return metrics.memory.total_bytes > 0
        ? (metrics.memory.used_bytes / metrics.memory.total_bytes) * 100
        : null
    case 'diskRead':
      return metrics.disk.read_bytes_per_sec
    case 'diskWrite':
      return metrics.disk.write_bytes_per_sec
    case 'networkRx':
      return metrics.network.rx_bytes_per_sec
    case 'networkTx':
      return metrics.network.tx_bytes_per_sec
  }
}

const DEFAULT_WINDOW_SECONDS = 300 // 5 minutes

export function useMetricsHistory(
  metrics: MetricsSnapshot | null,
) {
  const buffersRef = useRef(createBuffers())
  const engineBuffersRef = useRef<
    Record<string, Record<string, CircularBuffer<DataPoint>>>
  >({})
  const eventBufferRef = useRef(
    new CircularBuffer<GpuEventData>(EVENT_BUFFER_CAPACITY),
  )
  const requestBuffersRef = useRef<
    Record<string, CircularBuffer<InferenceRequestData>>
  >({})
  const lastTimestampRef = useRef<number>(0)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!metrics || metrics.timestamp_ms === lastTimestampRef.current) return
    lastTimestampRef.current = metrics.timestamp_ms

    const ts = metrics.timestamp_ms
    const buffers = buffersRef.current

    for (const key of SYSTEM_METRIC_KEYS) {
      const val = extractValue(metrics, key)
      if (val !== null) {
        buffers[key].push({ timestamp: ts, value: val })
      }
    }

    // Engine-specific metrics
    for (const engine of metrics.engines) {
      const engineKey = `${engine.engine_type}-${engine.endpoint}`
      if (!engineBuffersRef.current[engineKey]) {
        engineBuffersRef.current[engineKey] = {
          tps: new CircularBuffer<DataPoint>(BUFFER_CAPACITY),
          avgTps: new CircularBuffer<DataPoint>(BUFFER_CAPACITY),
          perReqTps: new CircularBuffer<DataPoint>(BUFFER_CAPACITY),
          ttft: new CircularBuffer<DataPoint>(BUFFER_CAPACITY),
          kvCache: new CircularBuffer<DataPoint>(BUFFER_CAPACITY),
          e2eLatency: new CircularBuffer<DataPoint>(BUFFER_CAPACITY),
          promptTps: new CircularBuffer<DataPoint>(BUFFER_CAPACITY),
          avgPromptTps: new CircularBuffer<DataPoint>(BUFFER_CAPACITY),
          perReqPromptTps: new CircularBuffer<DataPoint>(BUFFER_CAPACITY),
          queueTime: new CircularBuffer<DataPoint>(BUFFER_CAPACITY),
          interTokenLatency: new CircularBuffer<DataPoint>(BUFFER_CAPACITY),
          batchSize: new CircularBuffer<DataPoint>(BUFFER_CAPACITY),
        }
      }
      const eb = engineBuffersRef.current[engineKey]
      if (engine.metrics) {
        if (engine.metrics.tokens_per_sec !== null) {
          eb.tps.push({ timestamp: ts, value: engine.metrics.tokens_per_sec })
        }
        if (engine.metrics.avg_tokens_per_sec !== null) {
          eb.avgTps.push({ timestamp: ts, value: engine.metrics.avg_tokens_per_sec })
        }
        if (engine.metrics.per_request_tps !== null) {
          eb.perReqTps.push({ timestamp: ts, value: engine.metrics.per_request_tps })
        }
        if (engine.metrics.ttft_ms !== null) {
          eb.ttft.push({ timestamp: ts, value: engine.metrics.ttft_ms })
        }
        if (engine.metrics.kv_cache_percent !== null) {
          eb.kvCache.push({
            timestamp: ts,
            value: engine.metrics.kv_cache_percent,
          })
        }
        if (engine.metrics.e2e_latency_ms !== null) {
          eb.e2eLatency.push({ timestamp: ts, value: engine.metrics.e2e_latency_ms })
        }
        if (engine.metrics.prompt_tokens_per_sec !== null) {
          eb.promptTps.push({ timestamp: ts, value: engine.metrics.prompt_tokens_per_sec })
        }
        if (engine.metrics.avg_prompt_tokens_per_sec !== null) {
          eb.avgPromptTps.push({ timestamp: ts, value: engine.metrics.avg_prompt_tokens_per_sec })
        }
        if (engine.metrics.per_request_prompt_tps !== null) {
          eb.perReqPromptTps.push({ timestamp: ts, value: engine.metrics.per_request_prompt_tps })
        }
        if (engine.metrics.queue_time_ms !== null) {
          eb.queueTime.push({ timestamp: ts, value: engine.metrics.queue_time_ms })
        }
        if (engine.metrics.inter_token_latency_ms !== null) {
          eb.interTokenLatency.push({ timestamp: ts, value: engine.metrics.inter_token_latency_ms })
        }
        if (engine.metrics.avg_batch_size !== null) {
          eb.batchSize.push({ timestamp: ts, value: engine.metrics.avg_batch_size })
        }
      }

      // Accumulate per-engine inference requests
      if (engine.recent_requests && engine.recent_requests.length > 0) {
        if (!requestBuffersRef.current[engineKey]) {
          requestBuffersRef.current[engineKey] =
            new CircularBuffer<InferenceRequestData>(REQUEST_BUFFER_CAPACITY)
        }
        for (const req of engine.recent_requests) {
          requestBuffersRef.current[engineKey].push(req)
        }
      }
    }

    // Accumulate GPU events
    if (metrics.gpu_events && metrics.gpu_events.length > 0) {
      for (const event of metrics.gpu_events) {
        eventBufferRef.current.push(event)
      }
    }

    setVersion((v) => v + 1)
  }, [metrics])

  const getChartData = useCallback(
    (metric: string): DataPoint[] => {
      // Force dependency on version for reactivity
      void version

      const windowMs = DEFAULT_WINDOW_SECONDS * 1000
      const now = lastTimestampRef.current
      const cutoff = now - windowMs

      // Check system metrics
      const systemBuffer =
        buffersRef.current[metric as MetricKey]
      if (systemBuffer) {
        return systemBuffer
          .toArray()
          .filter((dp) => dp.timestamp >= cutoff)
      }

      // Check engine metrics (format: "engineKey:metricName")
      const colonIndex = metric.lastIndexOf(':')
      if (colonIndex > 0) {
        const engineKey = metric.substring(0, colonIndex)
        const metricName = metric.substring(colonIndex + 1)
        const eb = engineBuffersRef.current[engineKey]
        if (eb && eb[metricName]) {
          return eb[metricName]
            .toArray()
            .filter((dp) => dp.timestamp >= cutoff)
        }
      }

      return []
    },
    [version],
  )

  const getSparklineData = useCallback(
    (metric: string, count = 30): number[] => {
      void version

      const systemBuffer =
        buffersRef.current[metric as MetricKey]
      if (systemBuffer) {
        return systemBuffer.last(count).map((dp) => dp.value)
      }

      const colonIndex = metric.lastIndexOf(':')
      if (colonIndex > 0) {
        const engineKey = metric.substring(0, colonIndex)
        const metricName = metric.substring(colonIndex + 1)
        const eb = engineBuffersRef.current[engineKey]
        if (eb && eb[metricName]) {
          return eb[metricName].last(count).map((dp) => dp.value)
        }
      }

      return []
    },
    [version],
  )

  const getEvents = useCallback((): GpuEventData[] => {
    void version

    const windowMs = DEFAULT_WINDOW_SECONDS * 1000
    const now = lastTimestampRef.current
    const cutoff = now - windowMs

    return eventBufferRef.current
      .toArray()
      .filter((e) => e.timestamp_ms >= cutoff)
  }, [version])

  const getRequests = useCallback(
    (engineKey?: string): InferenceRequestData[] => {
      void version

      const windowMs = DEFAULT_WINDOW_SECONDS * 1000
      const now = lastTimestampRef.current
      const cutoff = now - windowMs

      if (engineKey) {
        const buf = requestBuffersRef.current[engineKey]
        if (!buf) return []
        return buf.toArray().filter((r) => r.end_ms >= cutoff)
      }

      // Return all engines' requests
      const all: InferenceRequestData[] = []
      for (const buf of Object.values(requestBuffersRef.current)) {
        for (const r of buf.toArray()) {
          if (r.end_ms >= cutoff) {
            all.push(r)
          }
        }
      }
      return all
    },
    [version],
  )

  return { getChartData, getSparklineData, getEvents, getRequests }
}
