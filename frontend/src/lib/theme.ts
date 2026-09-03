export const NVIDIA_THEME = {
  accent: '#76B900',
  accentSubtle: 'rgba(118, 185, 0, 0.08)',
  accentBorder: 'rgba(118, 185, 0, 0.10)',
  healthy: '#76B900',
  warning: '#eab308',
  critical: '#ef4444',
  chartGrid: '#1a1a1e',
  chartAxis: '#52525b',
  chartLine: '#76B900',
  bgPage: '#08080a',
  bgCard: '#0d0d10',
  bgCardInner: '#111115',
  bgBorder: '#1e1e22',
  gaugeTrack: '#222226',
} as const

export const THRESHOLDS = {
  gpuTemp: { warning: 70, critical: 85 },
  gpuPower: { warning: 80, critical: 95 },
  cpuUsage: { warning: 80, critical: 95 },
  memoryUsage: { warning: 80, critical: 95 },
  kvCache: { warning: 70, critical: 90 },
} as const

export function thresholdColor(
  value: number,
  warning: number,
  critical: number,
): string {
  if (value >= critical) return NVIDIA_THEME.critical
  if (value >= warning) return NVIDIA_THEME.warning
  return NVIDIA_THEME.healthy
}

/**
 * The fill of one CPU core cell at a given load.
 *
 * More bands than `thresholdColor` gives, and dimmer at the bottom of the
 * scale: a core grid is read as a texture — which of them are hot, and whether
 * the load is spread or piled on a few — so an idle core has to recede rather
 * than sit at full green beside a saturated one.
 */
export function coreUsageColor(usagePercent: number): string {
  if (usagePercent >= 90) return NVIDIA_THEME.critical
  if (usagePercent >= 70) return '#eab308'
  if (usagePercent >= 40) return NVIDIA_THEME.accent
  if (usagePercent >= 10) return '#365314'
  return '#27272a'
}
