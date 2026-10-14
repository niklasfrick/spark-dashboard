import type { CSSProperties } from 'react'
import { useEngineRotation } from '@/hooks/useEngineRotation'
import { useLiveMotion } from '@/hooks/useLiveMotion'
import {
  ROTATION_INTERVALS,
  engineRotationLabel,
  parseEngineRotation,
  serializeEngineRotation,
  type EngineRotationSetting,
} from '@/lib/engineRotation'

/** Off first, then every interval: the choices the control offers, in order. */
const SETTINGS: readonly EngineRotationSetting[] = [null, ...ROTATION_INTERVALS]

/**
 * This browser's engine rotation: off, or how long each target is held — and,
 * while it runs, the countdown to the next step.
 *
 * It sits in the edit bar beside the page config because the two answer the
 * same question, what following panels show, at different scopes: the page
 * config writes the page's default for everyone, and this steps away from it
 * for this browser only. Nothing here is written to the configuration.
 *
 * The countdown is a CSS animation restarted per step, so the browser draws it
 * without a React render per frame, and it says the page is moving on its own
 * before the panels do. Following panels name what they are showing, so which
 * target the page is on stays legible without the control repeating it.
 */
export function EngineRotationControl() {
  const { setting, choose, available, running, stepKey } = useEngineRotation()
  const live = useLiveMotion()

  // Withheld with fewer than two engines running, where there is nothing to
  // rotate between, and while the page is being edited, like the page config
  // beside it. The hook above keeps running in both cases: it is what holds
  // the page on its target while frozen and hands it back to its source when
  // rotation stops.
  if (!available || !live) return null

  const countdown = { '--rotation-duration': `${setting}ms` } as CSSProperties

  return (
    <div
      title={
        running
          ? `Following engine panels step through all models and each running engine every ${engineRotationLabel(setting)}.`
          : 'Step following engine panels through all models and each running engine.'
      }
      className={`relative shrink-0 overflow-hidden flex items-center gap-1.5 rounded border pl-2 pr-1.5 py-1 text-[10px] uppercase tracking-wider leading-none transition-colors ${
        running ? 'border-[#76B900]/40 text-[#cfe98a]' : 'border-white/[0.08] text-zinc-300'
      }`}
    >
      <span>{running ? 'Rotating' : 'Rotate'}</span>
      <span className="relative flex items-center">
        <select
          aria-label="Engine rotation"
          value={serializeEngineRotation(setting)}
          onChange={(event) => choose(parseEngineRotation(event.target.value))}
          className="appearance-none bg-transparent pr-3 uppercase tracking-wider tabular-nums cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-[#76B900]/60 rounded-sm"
        >
          {SETTINGS.map((option) => (
            <option
              key={serializeEngineRotation(option)}
              value={serializeEngineRotation(option)}
              className="bg-[#0d0d10] text-zinc-200"
            >
              {engineRotationLabel(option)}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 10 6"
          className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 h-1.5 w-2 opacity-70"
        >
          <path
            d="M1 1l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      {running && (
        <span
          // Keyed by the step, so a new countdown restarts the animation from
          // full rather than continuing the last one.
          key={stepKey}
          data-testid="engine-rotation-countdown"
          aria-hidden="true"
          className="engine-rotation-bar absolute inset-x-0 bottom-0 h-0.5 bg-[#76B900]/70"
          style={countdown}
        />
      )}
    </div>
  )
}
