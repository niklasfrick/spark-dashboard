import { CircularBuffer } from './circular-buffer'
import { DEFAULT_TIME_WINDOW } from './dashboard/schema'
import { engineKey, gpuIndexOf, snapshotGpus } from './identity'
import { TIME_WINDOW_SECONDS, type TimeWindow } from '@/types/events'
import type { GpuEventData, InferenceRequestData, MetricsSnapshot } from '@/types/metrics'

export interface DataPoint {
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

const GPU_METRIC_KEYS: MetricKey[] = ['gpuUtil', 'gpuTemp', 'gpuPower', 'gpuClockGraphics']

/** The per-GPU series. Narrower than `MetricKey`: only these exist per GPU. */
export type GpuSeriesMetric = 'gpuUtil' | 'gpuTemp' | 'gpuPower' | 'gpuClockGraphics'

/**
 * The series key for one GPU's metric. Multi-GPU hosts read the
 * `gpu:<index>:<metric>` series; single-GPU hosts keep the legacy un-prefixed
 * keys so the pre-multi-GPU rendering stays byte-identical. One definition,
 * because the writer and every panel reading it must agree on it.
 */
export function gpuSeries(metric: GpuSeriesMetric, gpuIndex: number, multiGpu: boolean): string {
  return multiGpu ? `gpu:${gpuIndex}:${metric}` : metric
}

type EngineMetricsShape = NonNullable<MetricsSnapshot['engines'][number]['metrics']>

/**
 * Every engine series and where its sample comes from on a snapshot. The
 * buffer set is created from this table too, so the series names and the
 * field mapping cannot drift apart.
 */
const ENGINE_SERIES = [
  ['tps', (m) => m.tokens_per_sec],
  ['avgTps', (m) => m.avg_tokens_per_sec],
  ['perReqTps', (m) => m.per_request_tps],
  ['ttft', (m) => m.ttft_ms],
  ['kvCache', (m) => m.kv_cache_percent],
  ['prefixCacheHit', (m) => m.prefix_cache_hit_rate],
  ['e2eLatency', (m) => m.e2e_latency_ms],
  ['promptTps', (m) => m.prompt_tokens_per_sec],
  ['avgPromptTps', (m) => m.avg_prompt_tokens_per_sec],
  ['perReqPromptTps', (m) => m.per_request_prompt_tps],
  ['queueTime', (m) => m.queue_time_ms],
  ['interTokenLatency', (m) => m.inter_token_latency_ms],
  ['batchSize', (m) => m.avg_batch_size],
  ['ttftP50', (m) => m.ttft_percentiles?.p50_ms ?? null],
  ['ttftP95', (m) => m.ttft_percentiles?.p95_ms ?? null],
  ['ttftP99', (m) => m.ttft_percentiles?.p99_ms ?? null],
  ['itlP50', (m) => m.itl_percentiles?.p50_ms ?? null],
  ['itlP95', (m) => m.itl_percentiles?.p95_ms ?? null],
  ['itlP99', (m) => m.itl_percentiles?.p99_ms ?? null],
  ['e2eP50', (m) => m.e2e_percentiles?.p50_ms ?? null],
  ['e2eP95', (m) => m.e2e_percentiles?.p95_ms ?? null],
  ['e2eP99', (m) => m.e2e_percentiles?.p99_ms ?? null],
  ['tpot', (m) => m.tpot_ms],
  ['tpotP50', (m) => m.tpot_percentiles?.p50_ms ?? null],
  ['tpotP95', (m) => m.tpot_percentiles?.p95_ms ?? null],
  ['tpotP99', (m) => m.tpot_percentiles?.p99_ms ?? null],
  ['activeRequests', (m) => m.active_requests],
  ['queuedRequests', (m) => m.queued_requests],
  ['totalRequests', (m) => m.total_requests],
] as const satisfies ReadonlyArray<readonly [string, (m: EngineMetricsShape) => number | null]>

/** The per-engine series, named by the table above so a panel cannot ask for
 *  one that is never ingested. */
export type EngineSeriesName = (typeof ENGINE_SERIES)[number][0]

/**
 * The series key for one engine's metric. `key` is an engine key as produced by
 * `engineKey()` — one definition, because the ingest side and every panel that
 * charts an engine must agree on it.
 */
export function engineSeries(name: EngineSeriesName, key: string): string {
  return `${key}:${name}`
}

/** The series key of the event buffer, for subscriptions. */
export const EVENTS_SERIES = 'events'

/** The series key of one engine's request buffer (`requests` alone: all engines). */
export function requestsSeries(key?: string): string {
  return key ? `requests:${key}` : 'requests'
}

function createBuffers(): Record<MetricKey, CircularBuffer<DataPoint>> {
  const buffers = {} as Record<MetricKey, CircularBuffer<DataPoint>>
  for (const key of SYSTEM_METRIC_KEYS) {
    buffers[key] = new CircularBuffer<DataPoint>(BUFFER_CAPACITY)
  }
  return buffers
}

function createEngineBuffers(): Record<string, CircularBuffer<DataPoint>> {
  const buffers: Record<string, CircularBuffer<DataPoint>> = {}
  for (const [name] of ENGINE_SERIES) {
    buffers[name] = new CircularBuffer<DataPoint>(BUFFER_CAPACITY)
  }
  return buffers
}

function extractGpuValue(gpu: MetricsSnapshot['gpu'], key: MetricKey): number | null {
  switch (key) {
    case 'gpuUtil':
      return gpu.utilization_percent
    case 'gpuTemp':
      return gpu.temperature_celsius
    case 'gpuPower':
      return gpu.power_watts
    case 'gpuClockGraphics':
      return gpu.clock_graphics_mhz
    default:
      return null
  }
}

function extractValue(metrics: MetricsSnapshot, key: MetricKey): number | null {
  switch (key) {
    case 'gpuUtil':
    case 'gpuTemp':
    case 'gpuPower':
    case 'gpuClockGraphics':
      return extractGpuValue(metrics.gpu, key)
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

/**
 * The metrics history: every series the dashboard can chart, held in ring
 * buffers outside React, with per-series subscriptions.
 *
 * This is the external store behind React's `useSyncExternalStore`. Ingesting
 * a snapshot appends to whichever series carry a value and notifies only those
 * series' subscribers, so a panel subscribed to one series does not re-render
 * when a snapshot changes a different one. The previous shape — one global
 * version counter inside a hook — invalidated every consumer on every flush.
 *
 * Series keys are the vocabulary `getChartData` always accepted:
 * system series (`gpuUtil`), per-GPU series (`gpu:<index>:gpuUtil`), engine
 * series (`<engineKey>:tps`), plus `events` and `requests[:<engineKey>]`.
 *
 * Reads take a `TimeWindow`. The buffers retain the largest window (15 min);
 * the window is purely a read-side filter.
 */
export class MetricsHistoryStore {
  private buffers = createBuffers()
  private gpuBuffers: Record<string, Record<MetricKey, CircularBuffer<DataPoint>>> = {}
  private engineBuffers: Record<string, Record<string, CircularBuffer<DataPoint>>> = {}
  private eventBuffer = new CircularBuffer<GpuEventData>(EVENT_BUFFER_CAPACITY)
  private requestBuffers: Record<string, CircularBuffer<InferenceRequestData>> = {}
  private lastTimestamp = 0
  private lastSnapshot: MetricsSnapshot | null = null
  private ingested = 0
  private versions = new Map<string, number>()
  private seriesListeners = new Map<string, Set<() => void>>()
  private allListeners = new Set<() => void>()

  /**
   * Append one snapshot to every series it carries a value for, then notify
   * the changed series' subscribers. A snapshot with an already-seen timestamp
   * is a re-render artifact, not new data, and is ignored.
   */
  ingest(metrics: MetricsSnapshot): void {
    if (metrics.timestamp_ms === this.lastTimestamp) return
    this.lastTimestamp = metrics.timestamp_ms
    this.lastSnapshot = metrics

    const ts = metrics.timestamp_ms
    const changed = new Set<string>()

    for (const key of SYSTEM_METRIC_KEYS) {
      const val = extractValue(metrics, key)
      if (val !== null) {
        this.buffers[key].push({ timestamp: ts, value: val })
        changed.add(key)
      }
    }

    for (const gpu of snapshotGpus(metrics)) {
      const gpuKey = String(gpuIndexOf(gpu))
      if (!this.gpuBuffers[gpuKey]) {
        this.gpuBuffers[gpuKey] = createBuffers()
      }
      const gb = this.gpuBuffers[gpuKey]
      for (const key of GPU_METRIC_KEYS) {
        const val = extractGpuValue(gpu, key)
        if (val !== null) {
          gb[key].push({ timestamp: ts, value: val })
          changed.add(`gpu:${gpuKey}:${key}`)
        }
      }
    }

    for (const engine of metrics.engines) {
      const key = engineKey(engine)
      if (!this.engineBuffers[key]) {
        this.engineBuffers[key] = createEngineBuffers()
      }
      const eb = this.engineBuffers[key]
      if (engine.metrics) {
        for (const [name, sample] of ENGINE_SERIES) {
          const val = sample(engine.metrics)
          if (val !== null) {
            eb[name].push({ timestamp: ts, value: val })
            changed.add(`${key}:${name}`)
          }
        }
      }

      if (engine.recent_requests && engine.recent_requests.length > 0) {
        if (!this.requestBuffers[key]) {
          this.requestBuffers[key] = new CircularBuffer<InferenceRequestData>(
            REQUEST_BUFFER_CAPACITY,
          )
        }
        for (const req of engine.recent_requests) {
          this.requestBuffers[key].push(req)
        }
        changed.add(requestsSeries(key))
        changed.add(requestsSeries())
      }
    }

    if (metrics.gpu_events && metrics.gpu_events.length > 0) {
      for (const event of metrics.gpu_events) {
        this.eventBuffer.push(event)
      }
      changed.add(EVENTS_SERIES)
    }

    this.ingested++
    for (const series of changed) {
      this.versions.set(series, (this.versions.get(series) ?? 0) + 1)
    }
    // Notify after all versions are bumped, so a listener that reads several
    // series during its re-render sees one consistent snapshot.
    for (const series of changed) {
      const listeners = this.seriesListeners.get(series)
      if (listeners) for (const listener of listeners) listener()
    }
    for (const listener of this.allListeners) listener()
  }

  /** Subscribe to one series. The listener fires when that series gains data. */
  subscribe(series: string, listener: () => void): () => void {
    let listeners = this.seriesListeners.get(series)
    if (!listeners) {
      listeners = new Set()
      this.seriesListeners.set(series, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /** Subscribe to every ingested snapshot — the whole-dashboard equivalent of
   *  the old global version counter, for consumers that read many series. */
  subscribeAll(listener: () => void): () => void {
    this.allListeners.add(listener)
    return () => {
      this.allListeners.delete(listener)
    }
  }

  /** Monotonic per-series counter; the `getSnapshot` for a series subscription. */
  seriesVersion(series: string): number {
    return this.versions.get(series) ?? 0
  }

  /** Count of ingested snapshots; the `getSnapshot` for `subscribeAll`. */
  ingestVersion(): number {
    return this.ingested
  }

  /**
   * The most recently ingested snapshot, for panels whose current-value
   * display (a gauge, a rate pair) needs more of the snapshot than any one
   * series carries. Null until the first snapshot arrives.
   */
  latest(): MetricsSnapshot | null {
    return this.lastSnapshot
  }

  private cutoff(window: TimeWindow): number {
    return this.lastTimestamp - TIME_WINDOW_SECONDS[window] * 1000
  }

  /** The buffer a series key names: a system series (`gpuUtil`), a per-GPU
   *  series (`gpu:<index>:gpuUtil`), or an engine series (`<engineKey>:tps`). */
  private resolveBuffer(metric: string): CircularBuffer<DataPoint> | undefined {
    const systemBuffer = this.buffers[metric as MetricKey]
    if (systemBuffer) return systemBuffer

    const gpuMatch = metric.match(/^gpu:(\d+):(gpuUtil|gpuTemp|gpuPower|gpuClockGraphics)$/)
    if (gpuMatch) {
      return this.gpuBuffers[gpuMatch[1]]?.[gpuMatch[2] as MetricKey]
    }

    const colonIndex = metric.lastIndexOf(':')
    if (colonIndex > 0) {
      return this.engineBuffers[metric.substring(0, colonIndex)]?.[
        metric.substring(colonIndex + 1)
      ]
    }

    return undefined
  }

  getChartData(metric: string, window: TimeWindow = DEFAULT_TIME_WINDOW): DataPoint[] {
    const buffer = this.resolveBuffer(metric)
    if (!buffer) return []
    const cutoff = this.cutoff(window)
    return buffer.toArray().filter((dp) => dp.timestamp >= cutoff)
  }

  getEvents(window: TimeWindow = DEFAULT_TIME_WINDOW): GpuEventData[] {
    const cutoff = this.cutoff(window)
    return this.eventBuffer.toArray().filter((e) => e.timestamp_ms >= cutoff)
  }

  /** Recent requests, optionally narrowed to one engine. `key` is an engine
   *  key as produced by `engineKey()`; omit it for every engine's requests. */
  getRequests(key?: string, window: TimeWindow = DEFAULT_TIME_WINDOW): InferenceRequestData[] {
    const cutoff = this.cutoff(window)

    if (key) {
      const buf = this.requestBuffers[key]
      if (!buf) return []
      return buf.toArray().filter((r) => r.end_ms >= cutoff)
    }

    const all: InferenceRequestData[] = []
    for (const buf of Object.values(this.requestBuffers)) {
      for (const r of buf.toArray()) {
        if (r.end_ms >= cutoff) {
          all.push(r)
        }
      }
    }
    return all
  }
}
