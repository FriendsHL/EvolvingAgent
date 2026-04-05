import { mkdir, appendFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { LLMCallMetrics } from '../types.js'

/**
 * Persists LLM call metrics to JSONL files organized by date.
 * data/metrics/calls/YYYY-MM-DD.jsonl
 */
export class MetricsCollector {
  private metricsDir: string

  constructor(dataPath: string) {
    this.metricsDir = join(dataPath, 'metrics', 'calls')
  }

  async init(): Promise<void> {
    await mkdir(this.metricsDir, { recursive: true })
  }

  async record(metrics: LLMCallMetrics): Promise<void> {
    const date = metrics.timestamp.slice(0, 10) // YYYY-MM-DD
    const filePath = join(this.metricsDir, `${date}.jsonl`)
    await appendFile(filePath, JSON.stringify(metrics) + '\n', 'utf-8')
  }

  async recordAll(metricsList: LLMCallMetrics[]): Promise<void> {
    for (const m of metricsList) {
      await this.record(m)
    }
  }

  /** Read metrics for a specific date */
  async getByDate(date: string): Promise<LLMCallMetrics[]> {
    const filePath = join(this.metricsDir, `${date}.jsonl`)
    try {
      const content = await readFile(filePath, 'utf-8')
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LLMCallMetrics)
    } catch {
      return []
    }
  }

  /** Read all metrics for a date range */
  async getByDateRange(startDate: string, endDate: string): Promise<LLMCallMetrics[]> {
    const files = await readdir(this.metricsDir).catch(() => [])
    const allMetrics: LLMCallMetrics[] = []
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const date = file.replace('.jsonl', '')
      if (date < startDate || date > endDate) continue
      const metrics = await this.getByDate(date)
      allMetrics.push(...metrics)
    }
    return allMetrics
  }

  /** Aggregate metrics for a date range */
  async aggregate(startDate?: string, endDate?: string): Promise<{
    totalCalls: number
    totalPromptTokens: number
    totalCompletionTokens: number
    totalCacheRead: number
    totalCacheWrite: number
    avgCacheHitRate: number
    totalCost: number
    totalSavedCost: number
  }> {
    const files = await readdir(this.metricsDir).catch(() => [])
    const allMetrics: LLMCallMetrics[] = []

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const date = file.replace('.jsonl', '')
      if (startDate && date < startDate) continue
      if (endDate && date > endDate) continue

      const metrics = await this.getByDate(date)
      allMetrics.push(...metrics)
    }

    if (allMetrics.length === 0) {
      return {
        totalCalls: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        avgCacheHitRate: 0,
        totalCost: 0,
        totalSavedCost: 0,
      }
    }

    const totalCalls = allMetrics.length
    const totalPromptTokens = allMetrics.reduce((s, m) => s + m.tokens.prompt, 0)
    const totalCompletionTokens = allMetrics.reduce((s, m) => s + m.tokens.completion, 0)
    const totalCacheRead = allMetrics.reduce((s, m) => s + m.tokens.cacheRead, 0)
    const totalCacheWrite = allMetrics.reduce((s, m) => s + m.tokens.cacheWrite, 0)
    const avgCacheHitRate = allMetrics.reduce((s, m) => s + m.cacheHitRate, 0) / totalCalls
    const totalCost = allMetrics.reduce((s, m) => s + m.cost, 0)
    const totalSavedCost = allMetrics.reduce((s, m) => s + m.savedCost, 0)

    return {
      totalCalls,
      totalPromptTokens,
      totalCompletionTokens,
      totalCacheRead,
      totalCacheWrite,
      avgCacheHitRate,
      totalCost,
      totalSavedCost,
    }
  }
}
