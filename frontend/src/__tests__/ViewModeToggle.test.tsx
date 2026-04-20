import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ViewModeToggle } from '../components/ViewModeToggle'

describe('ViewModeToggle', () => {
  it('renders "Glanceable" text when mode is detailed', () => {
    render(<ViewModeToggle mode="detailed" onToggle={() => {}} />)
    expect(screen.getByText('Glanceable')).toBeDefined()
  })

  it('renders "Detailed" text when mode is glanceable', () => {
    render(<ViewModeToggle mode="glanceable" onToggle={() => {}} />)
    expect(screen.getByText('Detailed')).toBeDefined()
  })

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn()
    render(<ViewModeToggle mode="detailed" onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
