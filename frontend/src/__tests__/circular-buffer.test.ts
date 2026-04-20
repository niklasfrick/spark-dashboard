import { describe, it, expect } from 'vitest'
import { CircularBuffer } from '../lib/circular-buffer'

describe('CircularBuffer', () => {
  it('starts with length 0', () => {
    const buf = new CircularBuffer<number>(5)
    expect(buf.length).toBe(0)
  })

  it('tracks length after pushing items', () => {
    const buf = new CircularBuffer<number>(5)
    buf.push(1)
    buf.push(2)
    buf.push(3)
    expect(buf.length).toBe(3)
    expect(buf.toArray()).toEqual([1, 2, 3])
  })

  it('overwrites oldest items when full', () => {
    const buf = new CircularBuffer<number>(5)
    for (let i = 1; i <= 7; i++) buf.push(i)
    expect(buf.length).toBe(5)
    expect(buf.toArray()).toEqual([3, 4, 5, 6, 7])
  })

  it('clear() resets length to 0', () => {
    const buf = new CircularBuffer<number>(5)
    buf.push(1)
    buf.push(2)
    buf.clear()
    expect(buf.length).toBe(0)
    expect(buf.toArray()).toEqual([])
  })

  it('toArray() returns a dense array with no undefined entries', () => {
    const buf = new CircularBuffer<number>(5)
    buf.push(10)
    buf.push(20)
    const arr = buf.toArray()
    expect(arr).toHaveLength(2)
    expect(arr.every((v) => v !== undefined)).toBe(true)
  })

  it('isFull returns true when at capacity', () => {
    const buf = new CircularBuffer<number>(3)
    buf.push(1)
    buf.push(2)
    expect(buf.isFull).toBe(false)
    buf.push(3)
    expect(buf.isFull).toBe(true)
  })

  it('last(n) returns last n items', () => {
    const buf = new CircularBuffer<number>(10)
    for (let i = 1; i <= 8; i++) buf.push(i)
    expect(buf.last(3)).toEqual([6, 7, 8])
    expect(buf.last(10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})
