import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

// The whole point of the browser project: a real layout engine. jsdom reports
// every box as 0x0 and resolves no CSS, so the fit-to-viewport grid work in #68
// cannot be tested there at all. This is the smoke test that proves the project
// is wired — render a component, let the browser lay it out, measure it.
function Box() {
  return (
    <div style={{ width: 320, padding: 16, boxSizing: 'border-box' }}>
      <div data-testid="panel" style={{ height: 48, width: '50%' }} />
    </div>
  )
}

describe('browser mode', () => {
  it('lays out and measures a rendered component', () => {
    render(<Box />)

    const panel = screen.getByTestId('panel')
    expect(panel).toBeInTheDocument()

    // 320 minus 2x16 padding, halved: a number jsdom can never produce.
    const box = panel.getBoundingClientRect()
    expect(box.width).toBe(144)
    expect(box.height).toBe(48)
  })
})
