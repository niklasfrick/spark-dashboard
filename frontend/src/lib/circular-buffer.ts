export class CircularBuffer<T> {
  private buffer: Array<T | undefined>
  private head = 0
  private count = 0
  private readonly capacity: number
  private _cache: T[] | null = null

  constructor(capacity: number) {
    this.capacity = capacity
    this.buffer = new Array<T | undefined>(capacity)
  }

  push(item: T): void {
    this._cache = null
    const index = (this.head + this.count) % this.capacity
    if (this.count < this.capacity) {
      this.buffer[index] = item
      this.count++
    } else {
      this.buffer[this.head] = item
      this.head = (this.head + 1) % this.capacity
    }
  }

  toArray(): T[] {
    if (this._cache) return this._cache
    const result: T[] = []
    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.capacity
      result.push(this.buffer[index] as T)
    }
    this._cache = result
    return result
  }

  get length(): number {
    return this.count
  }

  get isFull(): boolean {
    return this.count === this.capacity
  }

  clear(): void {
    this._cache = null
    this.head = 0
    this.count = 0
  }

  last(n: number): T[] {
    const arr = this.toArray()
    return arr.slice(Math.max(0, arr.length - n))
  }
}
