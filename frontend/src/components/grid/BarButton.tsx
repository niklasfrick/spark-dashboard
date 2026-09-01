/**
 * The edit bar's button: small, quiet, and the same whether it begins a
 * session, ends one, or opens the palette. Shared so the bar's controls cannot
 * drift apart from each other one addition at a time.
 */
export function BarButton({
  primary = false,
  disabled = false,
  expanded,
  onClick,
  children,
}: {
  primary?: boolean
  disabled?: boolean
  /** Set when the button opens something, so it says whether that is open. */
  expanded?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded border transition-colors ${
        disabled
          ? 'border-white/[0.04] text-zinc-600 cursor-not-allowed opacity-60'
          : primary
            ? 'bg-[#76B900]/20 hover:bg-[#76B900]/30 border-[#76B900]/40 text-[#cfe98a]'
            : 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.06]'
      }`}
    >
      {children}
    </button>
  )
}
