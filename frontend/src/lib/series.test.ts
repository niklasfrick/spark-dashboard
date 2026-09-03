import { describe, expect, it } from 'vitest'
import { sumSeries } from './series'

describe('sumSeries', () => {
  it('adds values at matching timestamps', () => {
    const total = sumSeries(
      [
        { timestamp: 1000, value: 3 },
        { timestamp: 2000, value: 5 },
      ],
      [
        { timestamp: 1000, value: 4 },
        { timestamp: 2000, value: 6 },
      ],
    )
    expect(total).toEqual([
      { timestamp: 1000, value: 7 },
      { timestamp: 2000, value: 11 },
    ])
  })

  it('passes a timestamp only one series carries through unchanged, in order', () => {
    const total = sumSeries(
      [{ timestamp: 2000, value: 5 }],
      [
        { timestamp: 1000, value: 4 },
        { timestamp: 2000, value: 6 },
      ],
    )
    expect(total).toEqual([
      { timestamp: 1000, value: 4 },
      { timestamp: 2000, value: 11 },
    ])
  })

  it('sums nothing to nothing', () => {
    expect(sumSeries([], [])).toEqual([])
  })
})
