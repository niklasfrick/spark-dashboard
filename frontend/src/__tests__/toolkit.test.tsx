import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Guards the toolkit itself: if `src/test/setup.ts` stops being registered, or
// user-event stops being installed, this fails loudly instead of every spec
// failing obscurely.
describe('test toolkit', () => {
  it('registers the jest-dom matchers from the setup module', () => {
    render(<button>ping</button>)

    expect(screen.getByRole('button', { name: 'ping' })).toBeInTheDocument()
  })

  it('drives typing through user-event, one keystroke at a time', async () => {
    const user = userEvent.setup()
    const seen: string[] = []
    render(<input aria-label="filter" onChange={(e) => seen.push(e.target.value)} />)

    await user.type(screen.getByLabelText('filter'), 'ab')

    // fireEvent.change would have produced a single 'ab'; real keystrokes don't.
    expect(seen).toEqual(['a', 'ab'])
  })
})
