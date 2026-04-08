/**
 * In-memory message dedup with TTL eviction.
 *
 * Why: Feishu retransmits webhook events on transient failures (slow
 * 200, network blip, etc.). Without dedup we'd answer the same user
 * message twice. openclaw uses a disk-backed cache; for a single
 * operator we don't need durability — restart is rare and at most one
 * duplicate slips through, which is preferable to the maintenance cost
 * of disk persistence.
 *
 * Pure data structure, no I/O. Tested in dedup.test.ts.
 */

export class FeishuDedup {
  private seen = new Map<string, number>() // messageId → expiresAt (epoch ms)
  private ttlMs: number

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs
  }

  /**
   * Returns true if the message id was already seen within TTL.
   * Marks it as seen if not. Atomic from caller's perspective —
   * concurrent calls for the same id will only return true once.
   */
  checkAndMark(messageId: string, now = Date.now()): boolean {
    this.evictExpired(now)
    const existing = this.seen.get(messageId)
    if (existing !== undefined && existing > now) {
      return true
    }
    this.seen.set(messageId, now + this.ttlMs)
    return false
  }

  /** Number of in-memory entries (after evicting expired). */
  size(now = Date.now()): number {
    this.evictExpired(now)
    return this.seen.size
  }

  /** Drop everything. Useful for tests. */
  clear(): void {
    this.seen.clear()
  }

  private evictExpired(now: number): void {
    // Sweep is O(n) — fine because n is bounded by message rate * 5min.
    // Single-operator bot caps at < 100 entries in practice.
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(id)
    }
  }
}
