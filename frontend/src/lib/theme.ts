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
