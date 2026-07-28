/**
 * What the operator is told when the dashboard is not showing their saved
 * configuration, or cannot save a new one.
 *
 * These exist because the alternative failure modes are all silent: a blank
 * screen, a preset that looks like someone deleted the layout, or edits that
 * vanish on the next reload. Each notice names the problem and says what is
 * being shown instead, so the dashboard is still worth reading while it is
 * degraded.
 */

import type { ConfigurationNotice } from '@/lib/dashboard/notices'

export function ConfigurationNotices({ notices }: { notices: ConfigurationNotice[] }) {
  if (notices.length === 0) return null

  return (
    <div className="shrink-0 flex flex-col gap-1 px-4 pt-2">
      {notices.map((notice) => {
        const { title, detail, tone } = describe(notice)
        return (
          <div
            key={notice.kind}
            role="alert"
            className={`rounded-md border px-3 py-1.5 text-sm ${toneClass[tone]}`}
          >
            <span className="font-semibold">{title}</span>{' '}
            <span className="opacity-80">{detail}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Amber for a degraded dashboard, red for an action that did not happen. */
const toneClass = {
  warning: 'border-amber-500/25 bg-amber-500/10 text-amber-200',
  error: 'border-red-500/25 bg-red-500/10 text-red-200',
} as const

interface NoticeText {
  title: string
  detail: string
  tone: keyof typeof toneClass
}

function describe(notice: ConfigurationNotice): NoticeText {
  switch (notice.kind) {
    case 'newer-version':
      return {
        title: 'Saved dashboard configuration is from a newer version.',
        detail:
          `It was written at configuration version ${notice.documentVersion}, and this build ` +
          `reads version ${notice.supportedVersion}. The default dashboard is shown instead. ` +
          'Saving replaces the stored configuration.',
        tone: 'warning',
      }
    case 'unsupported-version':
      return {
        title: 'Saved dashboard configuration is too old to read.',
        detail:
          `It is at configuration version ${notice.documentVersion}, which this build ` +
          `(version ${notice.supportedVersion}) can no longer bring forward. The default ` +
          'dashboard is shown instead.',
        tone: 'warning',
      }
    case 'unreadable':
      return {
        title: 'Saved dashboard configuration could not be read.',
        detail:
          'The server could not read the stored document, or it is damaged. The default ' +
          'dashboard is shown instead, and saving replaces the stored configuration.',
        tone: 'warning',
      }
    case 'unavailable':
      return {
        title: 'Saved dashboard configuration could not be loaded.',
        detail:
          'The server did not return it. The default dashboard is shown instead, so this is ' +
          'not the layout that is stored.',
        tone: 'warning',
      }
    case 'read-only':
      return {
        title: 'The dashboard is read-only.',
        detail:
          "The server's state directory is not writable, so layout changes cannot be saved.",
        tone: 'warning',
      }
    case 'save-failed':
      return {
        title: 'Saving the dashboard configuration failed.',
        detail: 'Your changes were not stored. Try saving again.',
        tone: 'error',
      }
    case 'too-large':
      return {
        title: 'The dashboard configuration is too large to save.',
        detail: 'The server refused it for its size. Remove some panels or pages and save again.',
        tone: 'error',
      }
  }
}
