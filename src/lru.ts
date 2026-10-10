/**
 * Tiny LRU — Map insertion order is recency order; `get` refreshes it.
 * Capacity 0 disables caching entirely.
 */
export class LruCache<T> {
  #map = new Map<string, T>()
  readonly capacity: number

  constructor(capacity: number) {
    // Explicit field (no parameter property) — Node strip-only TS mode.
    this.capacity = capacity
  }

  get size(): number {
    return this.#map.size
  }

  get(key: string): T | undefined {
    const hit = this.#map.get(key)
    if (hit !== undefined) {
      this.#map.delete(key)
      this.#map.set(key, hit)
    }
    return hit
  }

  set(key: string, value: T): void {
    if (this.capacity <= 0) return
    if (this.#map.has(key)) this.#map.delete(key)
    this.#map.set(key, value)
    if (this.#map.size > this.capacity) {
      this.#map.delete(this.#map.keys().next().value as string)
    }
  }
}
