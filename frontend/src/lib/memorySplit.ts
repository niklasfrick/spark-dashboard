import { formatBytes } from './format'
import type { MemoryMetrics } from '@/types/metrics'

/** One slice of the memory pool, in the shape the gauges render. */
export interface MemorySegment {
  value: number
  total: number
  color: string
  label: string
}

export interface MemorySplit {
  /** Used share of the pool, 0–100. */
  usedPercent: number
  /** GPU / CPU / cache / free, labelled with their absolute sizes. */
  segments: MemorySegment[]
}

/**
 * How the dashboard divides the host's memory pool for display: the GPU's
 * estimated share, the CPU remainder, reclaimable cache, and truly free —
 * one definition, so nothing rendering the pool can disagree about the split
 * or its colors.
 */
export function memorySplit(memory: MemoryMetrics): MemorySplit {
  const usedPercent =
    memory.total_bytes > 0 ? (memory.used_bytes / memory.total_bytes) * 100 : 0

  const gpuUsed = memory.gpu_estimated_bytes ?? 0
  const cpuUsed = Math.max(0, memory.used_bytes - gpuUsed)
  const cached = Math.min(memory.cached_bytes, memory.available_bytes)
  const free = Math.max(0, memory.available_bytes - cached)

  return {
    usedPercent,
    segments: [
      { value: gpuUsed, total: memory.total_bytes, color: '#76B900', label: `GPU: ${formatBytes(gpuUsed)}` },
      { value: cpuUsed, total: memory.total_bytes, color: '#3B82F6', label: `CPU: ${formatBytes(cpuUsed)}` },
      { value: cached, total: memory.total_bytes, color: '#71717A', label: `Cache: ${formatBytes(cached)}` },
      { value: free, total: memory.total_bytes, color: '#27272A', label: `Free: ${formatBytes(free)}` },
    ],
  }
}
