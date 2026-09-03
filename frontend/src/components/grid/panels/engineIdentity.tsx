import type { ProviderLogo } from '@/lib/providerLogo'
import type { DeploymentMode } from '@/types/metrics'

/**
 * The chrome that says *which* engine and *what model* — shared by the engine
 * status panel and the identity row every metric panel wears on a multi-engine
 * host, so the two never drift into describing the same engine differently.
 * The naming half lives in `engineLabel`, which is not a component file.
 */

/**
 * The provider mark: a white tile, because the logos are drawn for light
 * backgrounds and several are near-black on this one.
 *
 * A missing asset hides the tile rather than leaving a broken image — the
 * mapping recognizes more provider names than there are icon files shipped, so
 * an operator serving an unlisted model sees the name alone, not a gap.
 */
export function ProviderMark({ logo, size = 'sm' }: { logo: ProviderLogo; size?: 'sm' | 'lg' }) {
  return (
    <span
      className={`${
        size === 'lg' ? 'h-7 w-7' : 'h-4 w-4'
      } shrink-0 rounded bg-white p-0.5 flex items-center justify-center ring-1 ring-white/[0.06]`}
    >
      <img
        src={logo.url}
        alt={logo.alt}
        className="h-full w-full object-contain"
        onError={(event) => {
          const tile = event.currentTarget.parentElement
          if (tile) tile.style.display = 'none'
        }}
      />
    </span>
  )
}

/** One fact about the engine or its weights, as a small bordered tag. */
export function EngineChip({ label, iconSrc }: { label: string; iconSrc?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-medium leading-none text-zinc-200">
      {iconSrc && (
        <img
          src={iconSrc}
          alt=""
          aria-hidden="true"
          className="h-3 w-3 shrink-0 object-contain"
          onError={(event) => {
            event.currentTarget.style.display = 'none'
          }}
        />
      )}
      <span>{label}</span>
    </span>
  )
}

/** Where the engine is running: a container, or the host itself. */
export function DeploymentChip({ mode }: { mode: DeploymentMode }) {
  if (mode === 'Docker') return <EngineChip label="Docker" iconSrc="/icons/docker.svg" />

  // Native has no logo of its own, so it gets a rack glyph rather than a chip
  // that reads as missing an icon.
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-medium leading-none text-zinc-200">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-3 w-3 shrink-0 text-zinc-400"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="3" width="12" height="4" rx="1" />
        <rect x="2" y="9" width="12" height="4" rx="1" />
        <circle cx="4.5" cy="5" r="0.5" fill="currentColor" />
        <circle cx="4.5" cy="11" r="0.5" fill="currentColor" />
      </svg>
      <span>Direct</span>
    </span>
  )
}
