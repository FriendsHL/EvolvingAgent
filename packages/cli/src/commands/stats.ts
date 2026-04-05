import { MetricsCollector } from '@evolving-agent/core'
import { renderMetrics } from '../ui/renderer.js'
import { resolve } from 'node:path'

export async function statsCommand(options: { date?: string }): Promise<void> {
  const dataPath = resolve(process.cwd(), 'data', 'memory')
  const collector = new MetricsCollector(dataPath)
  await collector.init()

  const today = new Date().toISOString().slice(0, 10)
  const date = options.date ?? today

  const metrics = await collector.aggregate(date, date)
  renderMetrics(metrics)
}
