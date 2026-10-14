/**
 * Engine rotation: a page's following engine panels stepping through all
 * models and then each running engine on their own, for a wall display nobody
 * is standing at to change it.
 *
 * It is a **viewing preference**, kept per browser like the latency statistic,
 * and never part of the dashboard configuration: that document is one shared
 * answer to what the dashboard looks like (ADR-0003), and a kiosk choosing to
 * cycle must not set every other screen on the instance cycling too. It steps
 * the page selection's session layer, which is not saved either, so it moves
 * this browser's view of a page and nothing else.
 *
 * Pure helpers only: the stored setting and the clock live in
 * `useEngineRotationSetting` and `useEngineRotation`.
 */

import type { PageEngineTarget } from '@/lib/dashboard/selection'
import type { EngineSnapshot } from '@/types/metrics'

/** How long rotation holds each target, in milliseconds. */
export type RotationInterval = 3000 | 5000 | 10000 | 20000

/** The setting: how long each target is held, or null for off. */
export type EngineRotationSetting = RotationInterval | null

/** Every interval on offer, shortest first. The same four the old carousel had. */
export const ROTATION_INTERVALS: readonly RotationInterval[] = [3000, 5000, 10000, 20000]

/**
 * Off. The pre-0.14 tab carousel was on by default; this is not, because a
 * page whose source is one engine would start showing others nobody asked for.
 */
export const DEFAULT_ENGINE_ROTATION: EngineRotationSetting = null

/** The stored form of off. */
const OFF = 'off'

function isRotationInterval(value: number): value is RotationInterval {
  return (ROTATION_INTERVALS as readonly number[]).includes(value)
}

/** Reads a stored setting. Anything that is not one of the intervals is off. */
export function parseEngineRotation(raw: string | null | undefined): EngineRotationSetting {
  if (raw === null || raw === undefined || raw === OFF) return DEFAULT_ENGINE_ROTATION
  const interval = Number(raw)
  return isRotationInterval(interval) ? interval : DEFAULT_ENGINE_ROTATION
}

/** The stored form of a setting; round-trips through `parseEngineRotation`. */
export function serializeEngineRotation(setting: EngineRotationSetting): string {
  return setting === null ? OFF : String(setting)
}

/** What the control calls a setting: "Off", or the interval in seconds. */
export function engineRotationLabel(setting: EngineRotationSetting): string {
  return setting === null ? 'Off' : `${setting / 1000} s`
}

/**
 * The targets rotation steps through on this host: all models, then each
 * running engine in snapshot order — the old `[All Engines, ...engines]`.
 *
 * Empty with fewer than two engines running. One engine and the combination
 * of one engine are the same numbers, so there is nothing to rotate between;
 * engines that are detected but not serving have nothing to show either.
 */
export function rotationCycle(engines: readonly EngineSnapshot[]): PageEngineTarget[] {
  const running = engines.filter((engine) => engine.status.type === 'Running')
  if (running.length < 2) return []

  return [
    { kind: 'all' },
    ...running.map((engine): PageEngineTarget => ({ kind: 'engine', endpoint: engine.endpoint })),
  ]
}

/**
 * The step after `current`: the next target in the cycle, wrapping back to all
 * models after the last engine.
 *
 * A target the cycle does not hold — an engine that has stopped, a page source
 * naming one that is gone, or nothing resolved yet — steps to the head of the
 * cycle, so rotation always rejoins it at all models. Null only for an empty
 * cycle, where there is nothing to step to.
 */
export function nextRotationTarget(
  cycle: readonly PageEngineTarget[],
  current: PageEngineTarget | null,
): PageEngineTarget | null {
  if (cycle.length === 0) return null

  const at = current === null ? -1 : cycle.findIndex((target) => sameTarget(target, current))
  return cycle[(at + 1) % cycle.length]
}

/** One string per target, for telling two apart cheaply (`null` is "none"). */
export function rotationTargetKey(target: PageEngineTarget | null): string {
  if (target === null) return 'none'
  return target.kind === 'all' ? 'all' : `engine:${target.endpoint}`
}

function sameTarget(a: PageEngineTarget, b: PageEngineTarget): boolean {
  return rotationTargetKey(a) === rotationTargetKey(b)
}
