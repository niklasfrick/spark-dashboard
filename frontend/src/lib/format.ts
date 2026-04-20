import type { EngineType } from '@/types/metrics'

/** Format bytes to human-readable with auto-scaling: KB (<1MB), MB (<1GB), GB (>=1GB). One decimal. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${(bytes / 1_000).toFixed(1)} KB`
}

/** Format bytes/sec to human-readable rate string */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

/** Format watts with one decimal */
export function formatWatts(watts: number): string {
  return `${watts.toFixed(1)} W`
}

/** Format power as "current / limit W" */
export function formatPower(current: number | null, limit: number | null): string {
  if (current === null) return 'N/A'
  const currentStr = `${current.toFixed(1)} W`
  if (limit === null) return currentStr
  return `${current.toFixed(1)} W / ${limit.toFixed(1)} W`
}

/** Format temperature as integer with " C" suffix */
export function formatTemp(celsius: number | null): string {
  if (celsius === null) return 'N/A'
  return `${Math.round(celsius)} C`
}

/** Format percentage as integer with "%" suffix */
export function formatPercent(value: number | null): string {
  if (value === null) return 'N/A'
  return `${Math.round(value)}%`
}

/** Format clock speed as integer with " MHz" suffix */
export function formatMhz(mhz: number | null): string {
  if (mhz === null) return 'N/A'
  return `${Math.round(mhz)} MHz`
}

/** Get temperature color class: green <70, yellow 70-85, red >85 */
export function tempColor(celsius: number | null): string {
  if (celsius === null) return 'text-zinc-500'
  if (celsius >= 85) return 'text-red-500'
  if (celsius >= 70) return 'text-yellow-500'
  return 'text-green-500'
}

// --- LLM Engine Formatting Functions (Phase 2) ---

/** Format tokens per second: one decimal place. Null -> 'N/A'. Per UI-SPEC: unit is "tok/s" */
export function formatTps(tps: number | null): string {
  if (tps === null) return 'N/A'
  return tps.toFixed(1)
}

/** Format time to first token in milliseconds: integer. Null -> 'N/A'. Per UI-SPEC: unit is "ms" */
export function formatTtft(ms: number | null): string {
  if (ms === null) return 'N/A'
  return Math.round(ms).toString()
}

/** Auto-scale a duration given in ms to the most readable unit. Returns { value, unit }. */
export function formatDurationMs(ms: number | null): { value: string; unit: string } {
  if (ms === null) return { value: 'N/A', unit: '' }
  if (ms >= 60_000) return { value: (ms / 60_000).toFixed(1), unit: 'min' }
  if (ms >= 1_000) return { value: (ms / 1_000).toFixed(2), unit: 's' }
  return { value: Math.round(ms).toString(), unit: 'ms' }
}

/** Format the value portion of an auto-scaled duration (for BigNumberSparkline format prop). */
export function formatDurationValue(ms: number): string {
  return formatDurationMs(ms).value
}

/** Get the unit string for an auto-scaled duration. */
export function formatDurationUnit(ms: number | null): string {
  return formatDurationMs(ms).unit
}

/** Format request counts: "3 active / 1 queued". Both null -> 'N/A'. Per UI-SPEC. */
export function formatRequests(active: number | null, queued: number | null): string {
  if (active === null && queued === null) return 'N/A'
  const parts: string[] = []
  if (active !== null) parts.push(`${active} active`)
  if (queued !== null) parts.push(`${queued} queued`)
  return parts.join(' / ')
}

/** Format KV cache percentage: integer with %. Null -> 'N/A'. Per UI-SPEC. */
export function formatKvCache(percent: number | null): string {
  if (percent === null) return 'N/A'
  return `${Math.round(percent)}%`
}

/** Map EngineType enum to human-readable display name. */
export function engineDisplayName(engineType: EngineType): string {
  const names: Record<EngineType, string> = {
    Vllm: 'vLLM',
  }
  return names[engineType]
}
