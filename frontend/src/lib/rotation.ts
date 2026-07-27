/**
 * Auto-rotation state for the engine tab strip: whether rotation is on, and
 * how long each tab is held. Persisted as a single string ('off' or the
 * interval in ms).
 *
 * Lives here rather than beside `TabRotationControl` so the control file
 * exports only its component — a file mixing component and non-component
 * exports breaks Vite fast refresh (`react-refresh/only-export-components`).
 */

export type RotationInterval = 3000 | 5000 | 10000 | 20000

export interface RotationState {
  enabled: boolean
  interval: RotationInterval
}

export const DEFAULT_ROTATION_INTERVAL: RotationInterval = 10000

export function isRotationInterval(n: number): n is RotationInterval {
  return n === 3000 || n === 5000 || n === 10000 || n === 20000
}

export function serializeRotationState(state: RotationState): string {
  return state.enabled ? String(state.interval) : 'off'
}

export function parseRotationState(raw: string | null | undefined): RotationState {
  if (raw === 'off') return { enabled: false, interval: DEFAULT_ROTATION_INTERVAL }
  const n = Number(raw)
  if (isRotationInterval(n)) return { enabled: true, interval: n }
  return { enabled: true, interval: DEFAULT_ROTATION_INTERVAL }
}

export function serializeInterval(value: RotationInterval): string {
  return String(value)
}

export function parseInterval(raw: string): RotationInterval {
  const n = Number(raw)
  return isRotationInterval(n) ? n : DEFAULT_ROTATION_INTERVAL
}
