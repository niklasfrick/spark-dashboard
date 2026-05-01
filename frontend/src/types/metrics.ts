export interface MetricsSnapshot {
  timestamp_ms: number
  gpu: GpuMetrics
  cpu: CpuMetrics
  memory: MemoryMetrics
  disk: DiskMetrics
  network: NetworkMetrics
  engines: EngineSnapshot[]
  gpu_events: GpuEventData[]
}

/** Wire-format GPU event matching backend GpuEvent struct */
export interface GpuEventData {
  timestamp_ms: number
  event_type: string
  detail: string
}

/** Wire-format per-request inference metrics matching backend RecentRequest struct */
export interface InferenceRequestData {
  start_ms: number
  end_ms: number
  tokens_per_sec: number
  ttft_ms: number
}

export interface GpuMetrics {
  name: string | null
  utilization_percent: number | null
  temperature_celsius: number | null
  power_watts: number | null
  power_limit_watts: number | null
  clock_graphics_mhz: number | null
  clock_sm_mhz: number | null
  clock_memory_mhz: number | null
  fan_speed_percent: number | null
}

export interface CpuMetrics {
  name: string | null
  aggregate_percent: number
  per_core: CoreMetrics[]
}

export interface CoreMetrics {
  id: number
  usage_percent: number
}

export interface MemoryMetrics {
  total_bytes: number
  /** Headline pool size for the UI. On unified-memory systems this is sourced
   *  from NVML so the marketed capacity (e.g. 128 GB on DGX Spark) is shown
   *  instead of the kernel-visible total which excludes firmware carve-outs. */
  display_total_bytes?: number
  used_bytes: number
  available_bytes: number
  cached_bytes: number
  gpu_estimated_bytes: number | null
  gpu_memory_total_bytes: number | null
  gpu_memory_used_bytes: number | null
  is_unified: boolean
}

export interface DiskMetrics {
  name: string | null
  read_bytes_per_sec: number
  write_bytes_per_sec: number
}

export interface NetworkMetrics {
  name: string | null
  rx_bytes_per_sec: number
  tx_bytes_per_sec: number
}

// --- LLM Engine Types (Phase 2) ---

export type EngineType = 'Vllm'

export type DeploymentMode = 'Docker' | 'Native'

export type EngineStatus =
  | { type: 'Running' }
  | { type: 'Loading' }
  | { type: 'Stopped' }
  | { type: 'Error'; message: string }

export interface ModelInfo {
  name: string
  parameter_size: string | null
  quantization: string | null
  precision: string | null
  tensor_type: string | null
  model_type: string | null
  pipeline_tag: string | null
}

/** Tail-latency percentiles in milliseconds, derived from a Prometheus
 *  histogram on the backend. Any quantile may be null when there is not
 *  yet enough data to interpolate. */
export interface LatencyPercentiles {
  p50_ms: number | null
  p95_ms: number | null
  p99_ms: number | null
}

/** One Prometheus histogram bucket as shipped by the backend. The
 *  frontend uses these to recompute goodput at user-customized SLO
 *  thresholds. The backend replaces `+Inf` with `Number.MAX_VALUE`
 *  (Rust `f64::MAX`) so the wire format stays valid JSON. */
export interface HistogramBucket {
  le_seconds: number
  cumulative_count: number
}

export interface EngineMetrics {
  tokens_per_sec: number | null
  avg_tokens_per_sec: number | null
  per_request_tps: number | null
  ttft_ms: number | null
  active_requests: number | null
  queued_requests: number | null
  kv_cache_percent: number | null
  kv_cache_is_estimated: boolean
  total_requests: number | null
  // --- New metrics ---
  e2e_latency_ms: number | null
  prompt_tokens_per_sec: number | null
  avg_prompt_tokens_per_sec: number | null
  per_request_prompt_tps: number | null
  swapped_requests: number | null
  prefix_cache_hit_rate: number | null
  queue_time_ms: number | null
  inter_token_latency_ms: number | null
  preemptions_total: number | null
  avg_batch_size: number | null
  ttft_percentiles: LatencyPercentiles | null
  itl_percentiles: LatencyPercentiles | null
  e2e_percentiles: LatencyPercentiles | null
  /** % of TTFT observations meeting the TTFT SLO threshold. */
  ttft_goodput_pct: number | null
  /** % of ITL observations meeting the ITL SLO threshold. */
  itl_goodput_pct: number | null
  /** % of E2E observations meeting the E2E SLO threshold. */
  e2e_goodput_pct: number | null
  /** Raw TTFT histogram buckets. Used by the frontend to recompute
   *  goodput at user-customized SLO thresholds. Null while warming up
   *  or when the engine hasn't emitted the histogram yet. */
  ttft_buckets: HistogramBucket[] | null
  /** Raw ITL histogram buckets (cumulative). */
  itl_buckets: HistogramBucket[] | null
  /** Raw E2E histogram buckets (cumulative). */
  e2e_buckets: HistogramBucket[] | null
}

export interface EngineSnapshot {
  engine_type: EngineType
  endpoint: string
  status: EngineStatus
  model: ModelInfo | null
  metrics: EngineMetrics | null
  recent_requests: InferenceRequestData[]
  deployment_mode: DeploymentMode
}
