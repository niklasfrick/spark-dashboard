import { gpuIndexOf } from '@/lib/identity'
import type { GpuPanelResolution } from './useGpuPanel'

/**
 * The gauge label for a resolved GPU panel. On a multi-GPU host it names the
 * GPU the panel resolved to — a panel's data and its label must agree, and
 * with several GPUs the metric name alone would not say whose numbers these
 * are. Single-GPU hosts keep the metric label the pre-grid dashboard used.
 */
export function gpuLabel(
  resolution: Extract<GpuPanelResolution, { status: 'resolved' }>,
  metricLabel: string,
): string {
  return resolution.multiGpu ? `GPU ${gpuIndexOf(resolution.gpu)}` : metricLabel
}
