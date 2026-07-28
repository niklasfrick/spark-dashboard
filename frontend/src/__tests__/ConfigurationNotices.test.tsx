import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfigurationNotices } from '../components/ConfigurationNotices'
import { DASHBOARD_SCHEMA_VERSION } from '../lib/dashboard/schema'
import type { ConfigurationNotice } from '../lib/dashboard/notices'

/**
 * Every notice the dashboard can raise. The application-root spec drives the
 * load-time ones through the fetch seam; the save-time ones cannot be reached
 * from there until edit mode has a save control (#83), so their wording is
 * covered here rather than shipping unrendered.
 */
const everyNotice: ConfigurationNotice[] = [
  {
    kind: 'newer-version',
    documentVersion: DASHBOARD_SCHEMA_VERSION + 1,
    supportedVersion: DASHBOARD_SCHEMA_VERSION,
  },
  { kind: 'unsupported-version', documentVersion: 0, supportedVersion: DASHBOARD_SCHEMA_VERSION },
  { kind: 'unreadable' },
  { kind: 'unavailable' },
  { kind: 'read-only' },
  { kind: 'save-failed' },
  { kind: 'too-large' },
]

describe('ConfigurationNotices', () => {
  it('renders nothing when there is nothing wrong', () => {
    const { container } = render(<ConfigurationNotices notices={[]} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('gives every notice a banner of its own', () => {
    render(<ConfigurationNotices notices={everyNotice} />)

    expect(screen.getAllByRole('alert')).toHaveLength(everyNotice.length)
  })

  it('says something different for every notice', () => {
    // A message shared between two kinds would leave an operator unable to tell
    // "could not be saved" from "could not be loaded", which are opposite
    // problems with opposite next steps.
    render(<ConfigurationNotices notices={everyNotice} />)

    const messages = screen.getAllByRole('alert').map((banner) => banner.textContent)

    expect(new Set(messages).size).toBe(everyNotice.length)
    for (const message of messages) expect(message?.trim()).not.toBe('')
  })

  it('tells the operator a save did not happen', () => {
    render(<ConfigurationNotices notices={[{ kind: 'save-failed' }]} />)

    expect(screen.getByRole('alert')).toHaveTextContent(/saving .* failed/i)
    expect(screen.getByRole('alert')).toHaveTextContent(/not stored/i)
  })

  it('tells the operator a document too large will not fit, and what to do', () => {
    render(<ConfigurationNotices notices={[{ kind: 'too-large' }]} />)

    expect(screen.getByRole('alert')).toHaveTextContent(/too large/i)
    expect(screen.getByRole('alert')).toHaveTextContent(/remove some panels or pages/i)
  })

  it('names the versions when the document came from another build', () => {
    // The numbers are what turns "it does not work" into a report a maintainer
    // can act on.
    render(
      <ConfigurationNotices
        notices={[{ kind: 'newer-version', documentVersion: 7, supportedVersion: 3 }]}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(/7/)
    expect(screen.getByRole('alert')).toHaveTextContent(/3/)
  })
})
