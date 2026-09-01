import { describe, expect, it } from 'vitest'
import { TIME_WINDOWS, TIME_WINDOW_SECONDS } from '../types/events'

// The offered list and the table it is read against are two declarations of one
// thing: a window added to the table and not the list is a window no panel can
// be given, and one added to the list alone would read as zero seconds.
describe('the time windows a panel can cover', () => {
  it('offers exactly the windows the store can read', () => {
    expect([...TIME_WINDOWS].sort()).toEqual(Object.keys(TIME_WINDOW_SECONDS).sort())
  })

  it('offers them shortest first', () => {
    const spans = TIME_WINDOWS.map((window) => TIME_WINDOW_SECONDS[window])

    expect(spans).toEqual([...spans].sort((a, b) => a - b))
  })
})
