import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createPortal } from 'react-dom'
import { useDismissablePopover } from '@/hooks/useDismissablePopover'

// A popover portalled out of its container — the SLO settings, which render at
// the end of the page so no panel clips them (#123). The document listener
// judges "outside" by DOM containment, and a portal is not inside its trigger's
// container, so the popover has to be named to the hook as inside too.

function PortalledPopover() {
  const { open, toggle, containerRef, popoverRef } = useDismissablePopover<HTMLButtonElement>()

  return (
    <>
      <button ref={containerRef} type="button" onClick={toggle}>
        Settings
      </button>
      <p>Somewhere else on the page</p>
      {open &&
        createPortal(
          <div ref={popoverRef} role="dialog" aria-label="Settings">
            <input aria-label="Threshold" />
          </div>,
          document.body,
        )}
    </>
  )
}

const popover = () => screen.queryByRole('dialog', { name: 'Settings' })

async function opened() {
  render(<PortalledPopover />)
  await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
  expect(popover()).toBeInTheDocument()
}

describe('useDismissablePopover with a portalled popover', () => {
  it('stays open when the pointer goes down inside the popover', async () => {
    await opened()

    await userEvent.click(screen.getByRole('textbox', { name: 'Threshold' }))
    fireEvent.touchStart(screen.getByRole('textbox', { name: 'Threshold' }))

    expect(popover()).toBeInTheDocument()
  })

  it('closes when the pointer goes down outside both the trigger and the popover', async () => {
    await opened()

    await userEvent.click(screen.getByText('Somewhere else on the page'))

    expect(popover()).not.toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    await opened()

    await userEvent.keyboard('{Escape}')

    expect(popover()).not.toBeInTheDocument()
  })

  it('toggles from the trigger, which is not an outside click', async () => {
    await opened()

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))

    expect(popover()).not.toBeInTheDocument()
  })
})
